# 03 · 上游适配层

本页说明 `server.mjs` 如何把不同上游统一成 MacCMS 结构。所有适配函数都在 `server.mjs` 内，只有直播适配在 `live.mjs`。

## 1. 适配器总览

| 适配器 | 上游 | 协议 | 入口函数 | 产出 |
| --- | --- | --- | --- | --- |
| 4K | `4kcz.com` 及镜像 | HTML 页面 | `fetchFourkList/Search/Detail` | MacCMS 行 + `4kcz-<id>` |
| 暴风 | `bfzy1–5.tv` | MacCMS JSON | `fetchBfzyList/Detail/Search` | MacCMS 行 + 纯数字 id |
| 豆瓣 | `m.douban.com` | 公开 JSON | `fetchDoubanRankPool` | 榜单候选片名/年份 |
| 360kan | `api.web.360kan.com` | 公开 JSON | `collectKanRecommendations` | 推荐片名 → 匹配本站片源 |
| 直播 | M3U 清单源 | M3U8 | `LiveCollector`（live.mjs） | 合并后的频道/线路 |

统一输出结构（MacCMS）：

```json
{
  "code": 1, "msg": "数据列表",
  "page": 1, "pagecount": 10, "limit": 40, "total": 400,
  "list": [ { "vod_id": "...", "vod_name": "...", "vod_play_from": "...", "vod_play_url": "..." } ],
  "class": [ ... ]
}
```

## 2. 4K HTML 适配器

### 2.1 抓取与 WAF 规避

[`fourkFetch(baseHost, path, deadline)`](../../dyrs-vod-web/server.mjs#L725-L742)：

- URL 必须通过 [`fourkSourceAllowed()`](../../dyrs-vod-web/server.mjs#L672-L680) 校验（协议 + 主机名，允许 `www.` 前缀）。
- 使用 `hostSlot(baseHost)` 限速，并把排队耗时补偿进 Deadline。
- 固定 `tls12: true`：4K 站 WAF 会拦截 Node 默认 TLS 1.3 指纹，必须降到 TLS 1.2。
- 跟随重定向，但目标仍要满足 `fourkSourceAllowed`。
- [`assertFourkHtml()`](../../dyrs-vod-web/server.mjs#L718-L723) 校验：必须像 HTML；命中「访问已被拦截 / 站点已停止运行 / 人机验证 / 验证码」等文案时抛 `upstreamFailure(..., { blocked: true })`。

### 2.2 镜像遍历

[`withFourkHosts(key, ttl, operation)`](../../dyrs-vod-web/server.mjs#L867-L898)：

1. 先查 `fourkCache`；
2. 合并同 key 的并发请求（`inflightFourk`）；
3. 按 `FOURKCZ_HOSTS` 顺序尝试，跳过冷却中的主机；
4. 每次给 `Date.now() + UPSTREAM_TIMEOUT_MS` 的 Deadline；
5. 失败时按 `error.hostCool`/`error.blocked` 设置冷却；
6. 全部失败抛出最后一个错误。

### 2.3 列表解析 `parseFourkListing`

[L744-811](../../dyrs-vod-web/server.mjs#L744-L811)：

- 逐个 `<li>` 块找带 `dytit` class 的 `<h3>`；
- 从 `<a href="/movie/<id>.html">` 提取 id、片名；
- 读取海报 `data-original` 或 `src`；
- 读取 `jidi`（备注）、`inzhuy`（演员）、`furk`/`qb`（卡片分类/清晰度标签）；
- 用 `FOURK_CARD_TYPES` 把标签映射成 type_id；
- 从分页链接 `.../page/N` 推断 `pagecount`；
- 空结果时：列表页抛「结构变化」；搜索页若 `allowEmpty` 则允许空，但要求页面仍有 `main`/`mi_cont` 结构。

### 2.4 详情解析 `parseFourkDetail`

[L813-863](../../dyrs-vod-web/server.mjs#L813-L863)：

- `<h1>` 作为片名；
- 遍历 `<li>`，按「键：值」提取年份、地区、语言、主演、导演、类型；
- `dyimg` 块中的 `<img src>` 作为海报；
- `og:description` / `description` 作为简介；
- 所有 `/v_play/<token>.html` 链接作为剧集，名称经 `cleanField` 清洗（把 `$`、`#` 替换成全角，避免破坏 MacCMS 分隔符）；
- 没有剧集 → 抛错；
- 根据「类型/分类」关键词和剧集数量推断 `type_id`（综艺 3、动漫 4、短剧 5、电视剧 2、电影 1）。

### 2.5 列表/搜索/详情入口

| 函数 | 说明 | 行号 |
| --- | --- | --- |
| `fetchFourkList({ pg, t })` | 一级分类映射到 `FOURKCZ_CATEGORY_PATHS`；每页 20 条上游，按 `PAGE_SIZE` 计算需要抓几页；串行抓取多栏目页并去重 | [L900-943](../../dyrs-vod-web/server.mjs#L900-L943) |
| `fetchFourkSearch(wd, pg)` | `/search.php?searchword=...&page=` | [L945-952](../../dyrs-vod-web/server.mjs#L945-L952) |
| `fetchFourkDetail(id)` | 校验 `4kcz-<数字>`，抓 `/movie/<id>.html` | [L954-961](../../dyrs-vod-web/server.mjs#L954-L961) |
| `hydrateFourk(list)` | 逐条抓详情补全（4K 镜像会限流，串行） | [L1072-1087](../../dyrs-vod-web/server.mjs#L1072-L1087) |

## 3. 暴风 MacCMS 适配器

### 3.1 抓取 `upstreamJson(params, ttl)`

[L606-650](../../dyrs-vod-web/server.mjs#L606-L650)：

- 查询串由 `buildQuery` 生成；`wd` 参数名会被编码成 `%77%64`，因为上游 WAF 拒绝字面量 `wd=`。
- 先查 `jsonCache`，再合并 `inflightJson` 并发请求。
- 依次尝试 `UPSTREAM_HOSTS`，跳过冷却主机。
- 只有 2xx 且能解析为 JSON 对象才成功；否则冷却该主机并切换。
- 成功结果按 `ttl` 写入缓存，缓存超过 400 条时清理过期项。

### 3.2 列表 `fetchBfzyList`

[L995-1056](../../dyrs-vod-web/server.mjs#L995-L1056)：

- 解析 `t`：一级分类 → 多个 MacCMS 子分类；二级分类 → 单个 type_id；空 → 不传分类。
- 对每个子分类、每个需要的上游页调用 `mergeOnePage`，串行合并去重。
- 按 `vod_time` 倒序，截取 `PAGE_SIZE`。
- 非播放模式（`withPlay=false`）调用 `hydrate()` 补齐年份/地区等精简列表缺失字段。

### 3.3 详情与搜索

| 函数 | 说明 | 行号 |
| --- | --- | --- |
| `fetchBfzyDetail(ids)` | `ac=detail&ids=...` | [L1109-1112](../../dyrs-vod-web/server.mjs#L1109-L1112) |
| `fetchBfzySearch(wd, pg, withPlay)` | `ac=list|detail&wd=...&pg=...` | [L1133-1143](../../dyrs-vod-web/server.mjs#L1133-L1143) |
| `hydrate(list)` | 对当前页 id 发一次 `ac=detail&ids=` 批量补全 | [L1060-1070](../../dyrs-vod-web/server.mjs#L1060-L1070) |

## 4. 统一业务入口

[`fetchListLive({ pg, t, year, withPlay })`](../../dyrs-vod-web/server.mjs#L1089-L1107) 决定走哪个源：

```text
if 二级分类 type_id        → bfzy
else if 有 year            → bfzy
else if 4K 支持该一级分类   → 4K，失败则 bfzy
else                       → bfzy
```

[`fetchDetailLive(ids)`](../../dyrs-vod-web/server.mjs#L1114-L1131)：

- 把 id 分成暴风数字 id 与 4K id；
- 任一 id 不符合两家正则 → 直接抛 `invalid vod id`；
- 暴风批量请求 + 4K 逐个请求并行；
- 按请求顺序返回，缺失项过滤。

[`fetchSearchLive(wd, pg, withPlay)`](../../dyrs-vod-web/server.mjs#L1145-L1152)：先 4K 搜索，失败回退暴风。

## 5. 豆瓣榜单（最新 / 最热 / 高分）

目的：让「最新/最热/高分推荐」与豆瓣榜单一致，而不是只按上游默认顺序。豆瓣不可用时自动回退。

### 5.1 榜单来源

| 本站分类 | 豆瓣集合 |
| --- | --- |
| `new` 最新 | `movie_latest` |
| `hot` 最热 | `movie_hot` + `tv_hot` |
| `score` 高分 | `movie_top250` |

常量在 [L1247-1260](../../dyrs-vod-web/server.mjs#L1247-L1260)。

### 5.2 流程

1. [`fetchDoubanCollection(id, count)`](../../dyrs-vod-web/server.mjs#L1298-L1327)：豆瓣接口单次最多 50 条，循环翻页拿满候选。
2. [`doubanItemYear(item)`](../../dyrs-vod-web/server.mjs#L1330-L1335)：豆瓣 Top250 不含 year，从 `card_subtitle` 的「1994 / 美国 / …」补年份。
3. [`fetchDoubanRankPool(kind, y)`](../../dyrs-vod-web/server.mjs#L1345-L1389)：
   - 合并多个集合、按片名 key 去重；
   - 先查本地库 `findLocalExactVod(title)`；
   - 未命中的候选按片名分摊到多个健康镜像并行搜索（`searchTitlesOnHosts`）；
   - 只接受**片名完全相等**的候选；
   - 上游缺年份时用豆瓣年份补齐；
   - 最多保留 80 条（`RANK_POOL_LIMIT`）。
4. [`fetchRankedList(kind, pg, withPlay, year)`](../../dyrs-vod-web/server.mjs#L1392-L1416)：
   - 候选池写入数据库快照 `rank:douban:v2:<kind>:<year>`；
   - 按 `PAGE_SIZE` 切片返回；
   - 任何异常 → `fetchRankedListUpstream()`。

### 5.3 回退排序 `fetchRankedListUpstream`

[L1421-1468](../../dyrs-vod-web/server.mjs#L1421-L1468)：

- `new` 且无年份：直接透传暴风默认 `vod_time` 倒序；
- `hot`：取前 6 页 `ac=detail`，按 `vod_hits` 排序；
- `score`：取前 6 页 `ac=list`，按 `vod_score` 排序；
- 有年份时过滤 `vod_year`。

## 6. 360kan 推荐

用于首页与栏目推荐（`/api/vod/kan`）。

| 函数 | 作用 | 行号 |
| --- | --- | --- |
| `fetchKanJson(url)` | 请求 360kan，校验 HTTP 与 `errno` | [L1523-1538](../../dyrs-vod-web/server.mjs#L1523-L1538) |
| `fetchKanBlock(blockid, size)` | 首页推荐块（blockid=522） | [L1540-1545](../../dyrs-vod-web/server.mjs#L1540-L1545) |
| `fetchKanRank(cat, size)` | 栏目榜单（电影/电视剧/综艺/动漫） | [L1547-1552](../../dyrs-vod-web/server.mjs#L1547-L1552) |
| `findLocalExactVod(title)` | 本地库按片名精确匹配 | [L1554-1562](../../dyrs-vod-web/server.mjs#L1554-L1562) |
| `resolveKanVod(item)` | 本地优先，失败搜索暴风，结果写入 `KAN_TITLE_CACHE` | [L1564-1579](../../dyrs-vod-web/server.mjs#L1564-L1579) |
| `collectKanRecommendations(section)` | 取 30 个候选，解析出最多 12 条本站片源 | [L1581-1601](../../dyrs-vod-web/server.mjs#L1581-L1601) |
| `fetchKanRecommendations(section, limit)` | 走 `catalogQuery` 缓存 | [L1603-1610](../../dyrs-vod-web/server.mjs#L1603-L1610) |

注意：360kan 的 `size` 上限约 30，代码使用 `KAN_CANDIDATE_LIMIT = 30`。

## 7. 创意频道

静态定义 12 个频道（[L1616-1629](../../dyrs-vod-web/server.mjs#L1616-L1629)）：

| kind | 频道 | 规则 |
| --- | --- | --- |
| `guess` | 猜你喜欢 | 根据浏览器历史种子派生演员/类型；无种子回退口碑榜 |
| `score` | 高分榜 | `vod_score > 0`，按评分降序 |
| `praise` | 口碑榜 | `vod_score >= 6`，按 `vod_hits` 降序 |
| `series` | 漫威/哈利波特/速度与激情/唐探 | 片名关键词匹配 |
| `star` | 成龙/周星驰/吴京/沈腾 | `vod_actor` 严格包含演员名 |
| `guoman` | 国漫 | `type_id=40` 或动漫类 + 大陆地区 |

实现要点：

- [`collectChannelPool(ch)`](../../dyrs-vod-web/server.mjs#L1670-L1712)：实时采集候选池，采集后**再次按频道规则过滤**，避免上游模糊搜索结果混入无关内容。
- [`sortChannelPool(ch, all)`](../../dyrs-vod-web/server.mjs#L1661-L1668)：稳定排序（评分/热度 + vod_id），上限 120。
- [`fetchChannelPool(ch)`](../../dyrs-vod-web/server.mjs#L1714-L1738)：快照缓存 + 本地库合并；上游部分页失败时快照不会缩水。
- [`sliceChannelPool(pool, pg)`](../../dyrs-vod-web/server.mjs#L1740-L1746)：固定候选池分页，避免逐页回源导致重复/漂移。
- [`fetchGuessPool(seeds, exclude)`](../../dyrs-vod-web/server.mjs#L1749-L1761)：种子仅取库内已有详情，派生演员（≤6）/类型（≤8），并排除已看 id。

## 8. 播放解析

### 8.1 入口与缓存

- [`resolvePlayback(id, seq)`](../../dyrs-vod-web/server.mjs#L1870-L1911)：
  - 5 分钟进程内 `PLAY_URL_CACHE`；并发请求合并（`PLAY_URL_INFLIGHT`）；
  - 调用 `detailForPlay(id)` 实时拿详情（不走持久化详情）；
  - 暴风：直接用剧集 URL；
  - 4K：先 `resolveFourkMedia`，失败再 `resolveBfzyFallback`。
- [`detailForPlay(id)`](../../dyrs-vod-web/server.mjs#L1764-L1771)：按 id 前缀分流；采集结果回写数据库供后续 `ac=detail` 命中。

### 8.2 4K 播放页解析

[`resolveFourkMedia(ep)`](../../dyrs-vod-web/server.mjs#L1836-L1863)：

1. 校验剧集路径必须是 `/v_play/<token>.html`；
2. 抓播放页，找 `class` 含 `viframe` 且带 `src` 的 `<iframe>`；
3. 播放器 URL 必须通过 [`fourkPlayerAllowed()`](../../dyrs-vod-web/server.mjs#L682-L686)（源站或 `py1080p.com` 等可信域）；
4. 抓播放器 HTML，只做字符串提取，**不执行 JS**：
   - `const|let|var mysvg = "https://..."`；
   - `art.url = "https://..."`；
5. 媒体 URL 必须通过 [`fourkMediaAllowed()`](../../dyrs-vod-web/server.mjs#L688-L691)（`bytetos.com`、`bytedtos.com`、`py1080p.com`）；
6. 返回 `URL` 对象。

### 8.3 暴风精确回退

当 4K 播放页失效时：

1. [`bfzyTitleCandidates(row)`](../../dyrs-vod-web/server.mjs#L1793-L1810)：用 `ac=detail&wd=片名` 搜索，只保留**规范化片名完全相等**的候选；有年份时再按年份过滤；歧义（多个候选且无年份）直接返回空。
2. [`mapBfzyEpisode(...)`](../../dyrs-vod-web/server.mjs#L1812-L1823)：优先按集名（规范化后全等）匹配；失败再按集号（`第N集` / `EP N`）匹配；电影要求双方都只有 1 集且 seq=0；多个匹配视为歧义。
3. [`resolveBfzyFallback(...)`](../../dyrs-vod-web/server.mjs#L1825-L1834)：必须**唯一命中**，否则抛错，不取第一个模糊结果。

### 8.4 m3u8 广告过滤

- 规则表 `M3U8_AD_RULES`：只针对 `v.fengbao14.com` 的 `/video/adjump/` 分片。
- [`filterM3u8(body, media, rule)`](../../dyrs-vod-web/server.mjs#L1949-L1972)：
  - 跳过广告分片及其前的标签（包括紧随其后的 `#EXT-X-DISCONTINUITY`）；
  - 分片 URI 改为绝对地址（过滤后的清单由本站同源提供）；
  - 只按固定主机 + 固定路径精准匹配，避免误删正片。
- 其他域名维持原 302 跳转，不改写。

## 9. 适配器降级矩阵

| 失败点 | 降级路径 |
| --- | --- |
| 4K 某个镜像超时/被拦截 | 下一个 4K 镜像（`hostCool` 冷却） |
| 4K 全部失败（列表） | `fetchBfzyList` |
| 4K 搜索失败 | `fetchBfzySearch` |
| 4K 详情失败 | 5 秒超时后抛错，由上层 API 返回 502；播放场景转 `resolveBfzyFallback` |
| 暴风某镜像失败 | 下一个暴风镜像 |
| 暴风全部失败 | 抛错，API 返回 502 |
| 豆瓣失败 | 上游排序回退 |
| 360kan 失败 | 对应分类的上游列表前 12 条 |
| 频道采集失败 | 本地库候选池（`channelVods`） |
| 直播某清单源失败 | 下一个源；全部失败用本地 `assets` 兜底 |
