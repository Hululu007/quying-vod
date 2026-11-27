# 02 · 服务端核心（server.mjs）

[server.mjs](../../dyrs-vod-web/server.mjs) 约 2970 行，是全部 HTTP 路由与业务编排的唯一入口。本页说明它的路由表、响应约定、鉴权、后台接口与通用工具函数；上游适配细节见 [03-upstream-adapters.md](./03-upstream-adapters.md)。

## 1. 模块结构

| 区域 | 行号 | 内容 |
| --- | --- | --- |
| 依赖与存储初始化 | [L1-33](../../dyrs-vod-web/server.mjs#L1-L33) | 静态导入 `live.mjs`，动态导入 `db-layer.mjs` |
| 常量与配置 | [L35-173](../../dyrs-vod-web/server.mjs#L35-L173) | 上游主机、分类表、TTL、分页、MIME、鉴权路径 |
| 响应封装 | [L175-230](../../dyrs-vod-web/server.mjs#L175-L230) | JSON、gzip、可缓存响应、公开 base URL |
| 图片代理 | [L232-246](../../dyrs-vod-web/server.mjs#L232-L246) | 仅代理白名单海报 CDN |
| 播放改写与双源配对 | [L248-376](../../dyrs-vod-web/server.mjs#L248-L376) | `rewritePlay`、`withPlaySources`、`normalizeItem` |
| HTTP 抓取与限速 | [L378-481](../../dyrs-vod-web/server.mjs#L378-L481) | `httpGetText`、`hostSlot`、冷却 |
| 直播代理辅助 | [L483-604](../../dyrs-vod-web/server.mjs#L483-L604) | SSRF 判断、分片改写、快照冷启动 |
| 暴风适配 | [L606-650](../../dyrs-vod-web/server.mjs#L606-L650)、[L995-1152](../../dyrs-vod-web/server.mjs#L995-L1152) | `upstreamJson`、`fetchBfzy*` |
| 4K 适配 | [L652-961](../../dyrs-vod-web/server.mjs#L652-L961) | HTML 解析、镜像遍历 |
| 目录缓存 | [L1154-1242](../../dyrs-vod-web/server.mjs#L1154-L1242) | `catalogQuery`、后台刷新队列 |
| 豆瓣榜单 | [L1244-1468](../../dyrs-vod-web/server.mjs#L1244-L1468) | 最新/最热/高分 |
| 360kan 推荐 | [L1511-1610](../../dyrs-vod-web/server.mjs#L1511-L1610) | 首页/栏目推荐 |
| 创意频道 | [L1612-1761](../../dyrs-vod-web/server.mjs#L1612-L1761) | 12 个预设频道 |
| 播放解析 | [L1763-1972](../../dyrs-vod-web/server.mjs#L1763-L1972) | 4K 播放页 → 媒体地址，暴风回退，m3u8 广告过滤 |
| 对外负载 | [L1974-2083](../../dyrs-vod-web/server.mjs#L1974-L2083) | 屏蔽词、手动影片、列表/详情 payload |
| 采集与后台 | [L2085-2504](../../dyrs-vod-web/server.mjs#L2085-L2504) | 批量采集、TVBox 配置、`handleAdmin` |
| 请求处理 | [L2506-2975](../../dyrs-vod-web/server.mjs#L2506-L2975) | `requestHandler`、启动、全局异常 |

## 2. 常量与配置

| 常量 | 默认值 / 含义 | 行号 |
| --- | --- | --- |
| `UPSTREAM_HOSTS` | `bfzy1–5.tv` | [L39-42](../../dyrs-vod-web/server.mjs#L39-L42) |
| `FOURKCZ_HOSTS` | `www.4kcz.com, 4kcz.com, czzy.top, cz4k.com` | [L43-46](../../dyrs-vod-web/server.mjs#L43-L46) |
| `FOURKCZ_CATEGORY_PATHS` | 4K 一级分类路径映射 | [L47-51](../../dyrs-vod-web/server.mjs#L47-L51) |
| `PROVIDER_TYPES` | 一级 → MacCMS 子分类 | [L52-60](../../dyrs-vod-web/server.mjs#L52-L60) |
| `TYPE_NAMES` | MacCMS type_id → 中文名 | [L69-76](../../dyrs-vod-web/server.mjs#L69-L76) |
| `FOURK_CARD_TYPES` | 4K 卡片标签 → type_id | [L79-86](../../dyrs-vod-web/server.mjs#L79-L86) |
| `PAGE_SIZE` | `VOD_PAGE_SIZE`，默认 40，范围 10–100 | [L90](../../dyrs-vod-web/server.mjs#L90) |
| `REQUIRE_CARD` | `REQUIRE_CARD=1` 开启卡密授权 | [L93](../../dyrs-vod-web/server.mjs#L93) |
| `AUTH_PROTECTED_PATHS` | 需要卡密的精确路径集合 | [L96-103](../../dyrs-vod-web/server.mjs#L96-L103) |
| `UPSTREAM_MIN_INTERVAL_MS` | 同主机最小请求间隔，默认 400ms | [L108](../../dyrs-vod-web/server.mjs#L108) |
| `UPSTREAM_COOLDOWN_MS` | 普通失败冷却，默认 2 分钟 | [L109](../../dyrs-vod-web/server.mjs#L109) |
| `UPSTREAM_BLOCK_COOLDOWN_MS` | 被拦截/停运冷却，默认 15 分钟 | [L110](../../dyrs-vod-web/server.mjs#L110) |
| `TTL` | 列表 15min、详情 30min、TVBox 1h | [L114-118](../../dyrs-vod-web/server.mjs#L114-L118) |
| `IMAGE_HOST_RES` | 允许服务端代理的海报域名 | [L151-157](../../dyrs-vod-web/server.mjs#L151-L157) |
| `MIME` | 静态文件 Content-Type | [L159-173](../../dyrs-vod-web/server.mjs#L159-L173) |

## 3. 路由总表

`requestHandler` 按以下顺序分发（[L2507-2945](../../dyrs-vod-web/server.mjs#L2507-L2945)）：

| 方法 | 路径 | 说明 | 缓存 |
| --- | --- | --- | --- |
| OPTIONS | 任意 | CORS 预检，返回 204 | - |
| * | `/api/admin`、`/api/admin/*` | 交 `handleAdmin` 处理登录态与方法 | 视接口 |
| GET | `/api/health` | 健康检查 `{ ok, ts }` | 5s / 10s |
| GET | `/api/site` | 前台站点配置（名称、公告、广告开关、卡密开关） | s-maxage 300 |
| GET | `/api/ads?slot=carousel\|nav` | 公开广告位 | s-maxage 300 |
| GET | `/api/card/verify?code=` | 只校验卡密，不核销 | s-maxage 60 |
| POST | `/api/live/refresh` | 强制刷新直播快照（需后台会话 + 同源） | no-store |
| GET | `/api/live/groups` | 直播分组与总数 | 无缓存 |
| GET | `/api/live/channels?group&wd&pg&size` | 直播频道分页 | 无缓存 |
| GET | `/live.m3u` | 直播 M3U（TVBox 用） | 60s，授权下更短 |
| GET | `/admin`、`/admin/` | 后台页面 | no-cache |
| GET | `/img?url=` | 海报代理（白名单域名） | 1 天 |
| GET | `/live-proxy.m3u8?url=` | 代理 HTTP 直播清单并改写分片 | 30s |
| GET | `/live-seg?url=` | 代理直播分片 | 上游决定 |
| GET | `/api/vod/tvbox` | TVBox 配置 JSON | 1h |
| GET | `/play.m3u8?id&p` | 解析并 302 到媒体地址；特殊情况返回过滤后的 m3u8 | 30s |
| GET | `/resolve?id&p` | 解析并返回 JSON `{ code, msg, url, name }` | 5min |
| GET | `/api/vod/kan?section&limit` | 360kan 推荐，失败回退上游列表 | 5min |
| GET | `/api/vod/channels` | 创意频道清单 | 5min |
| GET/POST | `/api/vod/channel?id&pg` | 频道分页；`guess` 支持 POST 种子 | 普通 2min / 猜你喜欢 no-store |
| GET | `/api/vod/list?pg&t&year` | 前台列表 | 5min |
| GET | `/api/vod/search?wd&pg` | 搜索 | 5min |
| GET | `/api/vod/detail?ids=` | 详情（最多 20 个 ID） | 10min |
| GET | `/api.php/provide/vod`、`/vod` | MacCMS/TVBox 兼容入口 | 5–10min |
| * | 其他 `/api*` | JSON 404 | no-store |
| GET | 其他路径 | `public/` 静态文件；无扩展名回退 `index.html` | HTML no-cache，版本化资源 1 年 |

方法限制：除后台外，只允许 `GET`，以及 `POST /api/vod/channel`、`POST /api/live/refresh`；其他方法返回 405（[L2534-2537](../../dyrs-vod-web/server.mjs#L2534-L2537)）。

## 4. 响应封装

### `sendJson(res, status, data)`

- 序列化 JSON，`Cache-Control: no-store`，CORS `*`。
- 用于错误、鉴权失败、实时数据。

### `writeBody(res, status, headers, body)`

- 根据 `Accept-Encoding` 对文本类响应做 gzip（level 6），并加 `Vary: Accept-Encoding`。
- 可压缩类型正则：`text/*`、`json`、`javascript`、`svg+xml`、`xml`、`mpegurl`。
- 图片、字体、媒体分片不压缩。

### `sendJsonCacheable(res, status, data, { maxAge, sMaxAge, stale })`

- 输出 `Cache-Control: public, max-age, s-maxage, stale-while-revalidate`。
- 额外输出 `Cloudflare-CDN-Cache-Control`，让 CF 在 Vercel 之后仍可缓存。
- `REQUIRE_CARD=1` 时 `s-maxage ≤ 60`、`stale ≤ 120`。

### `publicBase(req)`

- 优先 `PUBLIC_URL`；否则用 `x-forwarded-host` / `host` + `x-forwarded-proto` 推断。
- 所有对外的播放链接、TVBox api、图片代理地址都基于它生成，**不泄露上游域名**。

## 5. 鉴权与安全

### 卡密授权

- 读取顺序：`?code=` → `X-Auth-Code` 头 → `qy_card` Cookie（[`extractCardCode`](../../dyrs-vod-web/server.mjs#L2230-L2238)）。
- [`enforceCardAuth`](../../dyrs-vod-web/server.mjs#L2241-L2253)：仅当 `REQUIRE_CARD=1` 且路径在 `AUTH_PROTECTED_PATHS` 中生效；调用 `adminStore.authorizeCard()`，首次访问自动核销；无效返回 401。
- 数据库不可用时返回 503，而不是放行。

### 后台会话

- 登录：`POST /api/admin/login`，密码经 `scrypt` 校验，成功后写 HttpOnly Cookie `qy_admin`（7 天）。
- `adminToken(req)` 读取 Cookie 并调用 `adminStore.validateSession()`。
- 未登录访问后台接口返回 401；修改类请求（非 GET）必须通过 [`sameOrigin()`](../../dyrs-vod-web/server.mjs#L2278-L2283)，要求 `Origin` 存在且 host 一致，否则 403。

### 其他安全约束

| 风险 | 处理 |
| --- | --- |
| 海报代理 SSRF | `/img` 仅允许 `IMAGE_HOST_RES` 中的域名，且必须返回 `image/*` |
| 直播/分片代理 SSRF | `isPrivateHost()` 拒绝 localhost、内网段；`ALLOW_LOCAL_PROXY=1` 仅供测试 |
| 路径穿越 | 静态文件 `path.normalize` 后必须仍以 `PUBLIC_DIR` 开头 |
| 上游 URL 伪造 | 4K 播放器/媒体 URL 必须命中 `fourkSourceAllowed` / `fourkPlayerAllowed` / `fourkMediaAllowed` |
| 请求体过大 | `readJsonBody` 默认上限 64KB，超过直接断开 |
| 手动影片注入 | 名称/分类/地址类型/长度全部校验，播放地址仅允许 http/https |

## 6. 后台接口（`handleAdmin`）

[`handleAdmin`](../../dyrs-vod-web/server.mjs#L2289-L2504) 自行处理登录态，不经过前台方法限制。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| POST | `/api/admin/login` | 密码登录，写 `qy_admin` Cookie |
| GET | `/api/admin/session` | 查询是否已登录 |
| POST/GET | `/api/admin/collect` | 批量采集；允许后台会话或 `collect_token` |
| POST | `/api/admin/logout` | 注销会话 |
| GET | `/api/admin/overview` | 概览统计（影片、查询、广告、卡密） |
| GET/PUT | `/api/admin/settings` | 读取/更新站点设置 |
| GET | `/api/admin/categories` | 分类树（`CLASSES`） |
| GET/POST | `/api/admin/videos` | 手动影片列表/新增 |
| DELETE | `/api/admin/videos/:manual-id` | 删除手动影片 |
| GET | `/api/admin/collect/status` | 采集游标、密钥、累计数量 |
| POST | `/api/admin/collect/token` | 生成新的采集密钥 |
| POST | `/api/admin/password` | 修改管理员密码（改完强制重登） |
| GET/POST | `/api/admin/ads` | 广告列表/新增 |
| PUT/DELETE | `/api/admin/ads/:id` | 更新/删除广告 |
| GET | `/api/admin/cards` | 卡密分页查询（状态/关键词） |
| POST | `/api/admin/cards/generate` | 批量生成卡密 |
| GET | `/api/admin/cards/export` | 导出 CSV（带 BOM） |
| PATCH/DELETE | `/api/admin/cards/:id` | 改状态/删除 |

采集接口的鉴权分支（[L2315-2335](../../dyrs-vod-web/server.mjs#L2315-L2335)）比较特殊：无后台会话时，用设置里的 `collect_token` 校验，专供 GitHub Actions 调用。

## 7. 关键函数速查

| 函数 | 作用 | 行号 |
| --- | --- | --- |
| `requestHandler(req, res)` | 总入口，路由分发 | [L2507](../../dyrs-vod-web/server.mjs#L2507) |
| `handleAdmin(req, res, p, url)` | 后台接口分发 | [L2289](../../dyrs-vod-web/server.mjs#L2289) |
| `httpGetText(target, opts)` | 统一上游 GET：超时/总 Deadline/重定向/TLS1.2 | [L378](../../dyrs-vod-web/server.mjs#L378) |
| `buildQuery(params)` | 构造上游查询串，`wd` 用 `%77%64` 规避 WAF | [L438](../../dyrs-vod-web/server.mjs#L438) |
| `hostSlot(key)` | 同主机请求串行限速 | [L454](../../dyrs-vod-web/server.mjs#L454) |
| `hostCooling/coolHost` | 主机冷却读写 | [L464-474](../../dyrs-vod-web/server.mjs#L464-L474) |
| `catalogQuery(key, ttl, loader, localLoader)` | 数据库快照读取/刷新 | [L1206](../../dyrs-vod-web/server.mjs#L1206) |
| `listCacheKey(...)` | 列表查询键 | [L1237](../../dyrs-vod-web/server.mjs#L1237) |
| `fetchList/fetchDetail/fetchSearch` | 业务层统一入口 | [L1470-1509](../../dyrs-vod-web/server.mjs#L1470-L1509) |
| `publicListPayload/publicDetailPayload` | 对外 payload（屏蔽词/手动片/图片代理） | [L2041-2083](../../dyrs-vod-web/server.mjs#L2041-L2083) |
| `normalizeItem(v, base, withPlay)` | 单条影片标准化 + 播放地址改写 | [L355](../../dyrs-vod-web/server.mjs#L355) |
| `rewritePlay(vod, base)` | 把上游播放地址改写成 `/play.m3u8?id=&p=` | [L275](../../dyrs-vod-web/server.mjs#L275) |
| `resolvePlayback(id, seq)` | 播放解析（带 5 分钟缓存） | [L1870](../../dyrs-vod-web/server.mjs#L1870) |
| `tvboxConfig(base, code)` | 生成 TVBox 配置 | [L2176](../../dyrs-vod-web/server.mjs#L2176) |
| `collectBatch({pages, force})` | 分批采集多个分类页 | [L2139](../../dyrs-vod-web/server.mjs#L2139) |
| `sitePayload()` | 前台站点配置 | [L2204](../../dyrs-vod-web/server.mjs#L2204) |

## 8. 错误与降级行为

| 场景 | 行为 |
| --- | --- |
| 上游全部失败（列表/搜索/详情） | `/api/vod/*` 与 MacCMS 入口返回 502 JSON `{ code: 0, msg, list: [] }` |
| 播放解析失败且是浏览器导航 | `/play.m3u8` 302 到 `/?error=playback` |
| 播放解析失败且是 API/客户端 | 返回 502 JSON |
| `/api` 未匹配 | 404 JSON `{ ok:false, error:'not found' }` |
| 存储不可用 | 后台接口 503；前台实时抓取继续工作 |
| 直播冷启动无快照 | 8 秒内等待采集；超时返回 `collecting:true` 占位（HTTP 200 + `Retry-After`） |
| 进程级异常 | `uncaughtException` / `unhandledRejection` 只记录日志，不退出 |
