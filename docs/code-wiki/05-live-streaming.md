# 05 · 直播模块

直播功能由三部分组成：

- [live.mjs](../../dyrs-vod-web/live.mjs)：清单解析、频道分类/合并、快照采集器；
- [server.mjs](../../dyrs-vod-web/server.mjs) 的 `/api/live/*`、`/live.m3u`、`/live-proxy.m3u8`、`/live-seg` 路由；
- [public/app.js](../../dyrs-vod-web/public/app.js) 的直播视图与 HLS 播放器。

## 1. live.mjs 导出

| 导出 | 作用 |
| --- | --- |
| `LIVE_GROUP_NAMES` | 分组顺序：央视、卫视、地方、体育、影视、少儿、港澳台、国际、其他 |
| `LIVE_EPG_URL` | `http://epg.51zmt.top:8000/e.xml` |
| `DEFAULT_LIVE_SOURCES` | 默认远端清单源（顺序即线路优先级） |
| `DISABLED_LIVE_SOURCES` | 已实测淘汰的源及原因（保留作记录） |
| `classifyLiveGroup(name, rawGroup)` | 频道归类 |
| `parseM3U(text, source)` | 解析 M3U 为频道条目 |
| `mergeLiveChannels(entries)` | 按规范化台名跨源合并线路 |
| `queryLiveChannels(channels, opts)` | 分组/关键词/分页查询 |
| `buildLiveM3U(channels)` | 重新生成标准 M3U（TVBox 用） |
| `LiveCollector` | 带 TTL、并发合并、失败重试的采集器 |

## 2. 数据源

### 2.1 默认远端源

[L13-36](../../dyrs-vod-web/live.mjs#L13-L36)：

| 来源 | 用途 |
| --- | --- |
| `m3u.ibert.me/fmml_itv.m3u`、`o_s_cn.m3u` | 国内台主力 |
| `vbskycn/iptv`（raw.githubusercontent.com） | 地方台主力 |
| `yonsm.github.io/IPTV/online/gwjx.m3u8` | 央视/卫视补充 |
| `Guovin/iptv-api`（gd 分支产物） | 大量地方台，量大但死链多 |
| `iptv-org` 分类清单（kids/sports/entertainment/music/movies/education/documentary/cn） | 分类补充 |
| `iptv-org/index.m3u`、`live.zbds.top` | 全量兜底 |

顺序很重要：**先采集的源会成为频道 `lines[0]`**。

`DISABLED_LIVE_SOURCES`（[L40-52](../../dyrs-vod-web/live.mjs#L40-L52)）记录了已淘汰源（gh-proxy 403、纯 RTSP/UDP、纯 IPv6、死链率过高、内容非直播等），不会再进入默认列表。

### 2.2 本地 `assets/`

[`readLocalLiveSources()`](../../dyrs-vod-web/live.mjs#L56-L80) 会读取：

- `dyrs-vod-web/assets/`
- `dyrs-vod-web/../assets/`
- `dyrs-vod-web/public/assets/`

规则：

- 所有 `.m3u` 文件都会被读取；
- 文件名以 `-live.m3u` 结尾 → `always: true`，**先于远端源加入**，其线路排到 `lines[0]`；
- 其他 `.m3u` → 仅当所有远端源都失败时作为兜底加入。

当前仓库 `assets/` 下：

| 文件 | 性质 |
| --- | --- |
| `cctv-live.m3u`、`weishi-live.m3u`、`defang-live.m3u` | 精选常驻（always） |
| `iptv-org.m3u`、`iptv4.m3u`、`myIPTV.m3u` | 全源失败时的本地兜底 |

## 3. 解析与清洗

### 3.1 `parseM3U`

[L262-294](../../dyrs-vod-web/live.mjs#L262-L294)：

1. 按行扫描 `#EXTINF:`；
2. [`splitExtinf`](../../dyrs-vod-web/live.mjs#L244-L252) 按第一个未加引号的逗号分离「属性头」和「频道名」；
3. [`extinfAttributes`](../../dyrs-vod-web/live.mjs#L254-L260) 解析 `tvg-id`、`tvg-name`、`tvg-logo`、`group-title`；
4. 下一行非注释即 URL；
5. [`httpUrl`](../../dyrs-vod-web/live.mjs#L120-L135)：只允许 http/https；媒体地址丢弃 IPv6 主机与 `.flv`（生产环境仅 IPv4 出网，flv 浏览器不兼容）；
6. 垃圾条目过滤（`JUNK_NAME_RE` / `JUNK_RAW_GROUP_RE`：支持作者、打赏、测试、广告、公众号等）；
7. 归类后写入 `{ name, tvgId, logo, rawGroup, group, url, source }`。

### 3.2 `cleanName` / `nameKey`

[L82-118](../../dyrs-vod-web/live.mjs#L82-L118)：

- `cleanName`：NFKC、去前导 `[BD]`、去尾部 `(720p)`、去 `50/60 fps`、去 `hevc`、`plus → +`、压缩空白；
- `nameKey`：跨源合并用的规范化 key：
  - `CCTV 1` / `CCTV-1` / `cctv1` / `CCTV-1综合` → `cctv1`；
  - `CCTV5 plus` → `cctv5+`；
  - `CGTN` → `cgtn`；
  - `BTV`/`BRTV`/`北京卫视` → `北京卫视`；
  - `XX卫视` 提取中文核心；
  - 其他：去空格/标点。

### 3.3 `classifyLiveGroup` 优先级

[L181-242](../../dyrs-vod-web/live.mjs#L181-L242)，从高到低：

1. **垃圾过滤**：命中垃圾名/垃圾 rawGroup → 返回空，直接丢弃；
2. **频道名含「卫视」**：若同时命中央视特征 → 央视；若命中港澳台特征且不在黑名单 → 港澳台；否则卫视；
3. **频道名含省市名**（`PROVINCE_NAMES`）→ 地方；但若明确是央视 → 央视；
4. **央视特征**：`CCTV/CETV/CGTN/央视/中央`，且不是 `Red CCTV/WCETV/DanceTV` 等伪央视；
5. **港澳台特征**：台湾/香港/澳门/凤凰/TVB/东森/三立等，排除爱奇艺、半岛等误标；
6. **卫视特征**：`卫视/衛視/Satellite TV`；
7. **地方命名特征**：`新闻综合/综合频道/公共频道/XX综合/XX新闻` 等；
8. **体育 / 少儿 / 影视**：关键词；
9. **rawGroup 兜底**（条件更严格，例如 rawGroup 标「央视」还要求频道名含「中」）；
10. **全英文或国际关键词** → 国际；
11. 其余 → 其他。

这样即使上游把「地方台」标成「央视」，或把「爱奇艺」标成「港澳台」，也能纠正。

### 3.4 `mergeLiveChannels`

[L296-347](../../dyrs-vod-web/live.mjs#L296-L347)：

- 以 `nameKey` 为合并键；
- 频道 id：`live-<sha1(nameKey) 前 16 位>`；
- 保留首个非空 `tvgId` / `logo`；
- 线路去重（同 URL 不重复），每个频道最多 5 条；
- 合并后如果分组是「其他」，用该频道所有上游 `rawGroup` 再试一次归类；
- 排序：分组顺序 → 中文名称（`localeCompare`，数字感知）。

HTTP 线路不会在这里丢弃：前端会优先选 HTTPS，HTTP 线路通过 `/live-proxy.m3u8` 代理，避免混合内容拦截。

### 3.5 `queryLiveChannels`

[L349-364](../../dyrs-vod-web/live.mjs#L349-L364)：按 group、`wd`（经 `nameKey` 规范化后包含匹配）过滤，分页大小 1–100，默认 60。

### 3.6 `buildLiveM3U`

[L370-379](../../dyrs-vod-web/live.mjs#L370-L379)：每个频道每条线路输出一个 `#EXTINF` + URL，带 `x-tvg-url`、`tvg-id`、`tvg-name`、`tvg-logo`、`group-title`。

## 4. `LiveCollector`

[L381-490](../../dyrs-vod-web/live.mjs#L381-L490)。

### 4.1 状态

| 字段 | 含义 |
| --- | --- |
| `snapshot` | 最近一次成功快照 |
| `inflight` | 正在进行的采集 Promise（并发合并） |
| `retryAfter` | 失败后的重试时间 |
| `ttl` | 快照有效期（默认 6 小时） |

### 4.2 `collect()`

1. 若未禁用本地源，先把 `-live.m3u` 常驻清单加入；
2. 串行遍历远端源（顺序 = 线路优先级）；
3. 对运营商内网清单（URL 含 `cmvideo` / `PLTV` / `wasulive`，或名称含 `fmml` / `ycl_iptv`）做**分片探针**：
   - 并行探测前 5 条分片，5 秒超时；
   - 至少 40% 且至少 2 条返回 `#EXTM3U` 才通过；
   - 不通过则跳过该源，避免收录「鉴权过期但清单还在」的假活源；
4. 远端全部为空时，加入非 always 的本地兜底清单，并标记 `stale: allRemoteDown`；
5. 全部为空 → 抛错；
6. `mergeLiveChannels` 合并；
7. 生成 `groups`（只保留 count > 0 的分组）与 `sources` 状态。

### 4.3 `getSnapshot({ force })`

- 未强制且快照未过期 → 直接返回；
- 在 `retryAfter` 之前 → 返回旧快照并标记 `stale`；
- 已有 `inflight` → 复用；
- 采集失败：设置 60 秒重试；有旧快照返回旧快照（stale），没有则抛错。

## 5. 服务端路由

### 5.1 采集器接线

[server.mjs L560-583](../../dyrs-vod-web/server.mjs#L560-L583) 创建 `LiveCollector`，其 `fetchText`：

- 主机冷却中直接抛错；
- `hostSlot()` 限速；
- `httpGetText` 带 `LIVE_FETCH_TIMEOUT_MS` 总 Deadline；
- 失败冷却该主机；
- 清单 > 40MB、为空或不以 `#EXTM3U` 开头 → 抛错。

### 5.2 冷启动保护

- `LIVE_COLD_WAIT_MS` 默认 8000ms；
- [`liveSnapshotOrNull()`](../../dyrs-vod-web/server.mjs#L587-L604)：已有快照立即返回；没有快照时最多等 8 秒，超时返回 null；
- 路由收到 null 时返回 `collecting: true` 占位（HTTP 200 + `Retry-After: 10`），前端每 5 秒重试；
- 非 Vercel 长驻进程启动时会后台预热（`LIVE_WARMUP != 0`）。

### 5.3 路由行为

| 路由 | 行为 |
| --- | --- |
| `GET /api/live/groups` | `{ total, updatedAt, stale, groups, sources }`，实时不缓存 |
| `GET /api/live/channels` | group 必须是 `LIVE_GROUP_NAMES` 之一；支持 `wd`、`pg`、`size`（1–100） |
| `GET /live.m3u` | `buildLiveM3U()`；`s-maxage` 默认 3600，授权模式 60 |
| `POST /api/live/refresh` | 需后台会话 + 同源，强制重采 |
| `GET /api/vod/tvbox` | `lives` 指向 `<base>/live.m3u`，授权模式自动带 `?code=` |

## 6. 直播代理与 SSRF 防护

### 6.1 `/live-proxy.m3u8`

[server.mjs L2673-2699](../../dyrs-vod-web/server.mjs#L2673-L2699)：

- `liveUrlAllowed(raw)`：只允许 http/https，拒绝内网/localhost（`ALLOW_LOCAL_PROXY=1` 时例外，仅测试）；
- 抓取清单，校验 `#EXTM3U`；
- [`rewriteM3u8Segments()`](../../dyrs-vod-web/server.mjs#L511-L521) 把所有分片 URI 改写成 `/live-seg?url=...`；
- 返回 `application/x-mpegURL`，30 秒缓存。

### 6.2 `/live-seg`

[`pipeUpstream()`](../../dyrs-vod-web/server.mjs#L523-L558)：

- 再次校验协议与私网地址；
- 302 直接透传；
- 非 2xx 透传错误；
- 成功则透传 Content-Type/Length 并流式 pipe；
- 上游错误 → 502 JSON。

由于约 80% 的线路分片是 HTTP，浏览器无法直连，服务端必须全量中转，这也是直播带宽消耗的主要来源。

## 7. 前端直播视图

代码在 [public/app.js](../../dyrs-vod-web/public/app.js)，从 `liveState`（约 L878）到 `renderLive()`（约 L1425）。

### 7.1 数据加载

- `loadLiveGroups()` → `/api/live/groups`，渲染分组 tab 与总频道数；
- `loadLiveChannels()` → `/api/live/channels?group&wd&pg&size`；
- 频道搜索输入 300ms 防抖；
- 冷启动 `collecting` 时每 5 秒自动重试，最多 10 次，之后提示手动刷新。

### 7.2 线路选择

- `preferredLiveLine(channel)`：优先 HTTPS 线路；
- `liveLineScore(url)` + `noteLiveHealth(url, ok)`：本地 `localStorage['qy-live-health']` 记录健康分，成功加分、失败扣分，排序时优先高分线路；
- `probeLiveUrl(url, timeout)`：播放前可探测可达性。

### 7.3 播放与错误恢复

[`loadLiveLine(channel, index)`](../../dyrs-vod-web/public/app.js#L996-L1130)：

- HTTPS 页面下，HTTP 线路自动走 `liveProxy()`（`/live-proxy.m3u8?url=`）；
- 15 秒连接超时 watchdog；
- 浏览器原生支持 HLS（Safari）→ 直接 `video.src`；
- 否则按需加载 `hls.js`，配置：关闭低延迟、`liveSyncDurationCount=3`、`maxBufferLength=20`、`capLevelToPlayerSize=true`、各级超时与重试；
- `MANIFEST_PARSED` 时做**编码预检**：
  - `levelVideoCodec(level)` 读取 CODECS；
  - `videoCodecSupported(codec)` 用 `MediaSource.isTypeSupported` 判断；
  - 整条线路都不可解码（典型 H.265）→ 切换线路；
  - 混合编码 → 锁定到可解码档位，避免 ABR 切到 H.265 后只有声音；
- 错误分级恢复：网络错误 `startLoad()`、媒体错误 `recoverMediaError()`，各给 2 次机会，仍失败才切线路；
- 卡顿自愈：等待/停滞 10 秒后跳到直播边缘并重新拉流，再过 10 秒仍无进展才换线路；
- [`watchLiveFrames`](../../dyrs-vod-web/public/app.js#L987-L994)：开始播放 8 秒后若 `videoWidth === 0`，判定「只有声音没有画面」并切换线路。

### 7.4 默认静音

直播首次播放默认静音（浏览器自动播放策略），用户可手动取消。

## 8. 工具脚本

| 脚本 | 用途 |
| --- | --- |
| [tools/pick-live-sources.mjs](../../dyrs-vod-web/tools/pick-live-sources.mjs) | 拉候选清单 → 探测 → 生成 `assets/*-live.m3u` 精选清单；支持 `--via=` 经线上代理探测 |
| [tools/live-reachability-probe.mjs](../../dyrs-vod-web/tools/live-reachability-probe.mjs) | 统计各分组可达率与 HTTPS 分片占比，输出终端表格 + `live-report.json` |
| [tools/refresh-live-sources.mjs](../../dyrs-vod-web/tools/refresh-live-sources.mjs) | 自检并原地重写 `assets/*-live.m3u`，剔除不可达/IPv6 线路；`--dry-run` 只报告 |
| [tools/verify-local-live.mjs](../../dyrs-vod-web/tools/verify-local-live.mjs) | 本地校验 `assets/*.m3u` 的识别情况与频道数 |

脚本说明：运营商 CDN 会拒绝海外 IP，精选探测应在**目标观众网络**（国内机器）运行，否则会误删国内可达线路。

## 9. 已知限制

- 海外部署天然无法访问国内运营商 IPTV 源，只能保留实测可达的海外/公网线路；
- 直播分片以 HTTP 为主，服务端中转带宽成本高；
- 上游清单随时可能失效，精选 `assets` 需要定期重新探测；
- 频道分组依赖启发式规则，上游乱标时仍可能有个别误分类。
