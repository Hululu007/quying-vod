## 项目概述
把 `4kcz.com`（线路一，镜像 `czzy.top`、`cz4k.com`）与 `bfzy1–5.tv`（线路二）的公开网页适配为一个统一的 TVBox / MacCMS 兼容 JSON 片库。服务只读取源站公开页面，不保存影片文件；播放时实时解析短时有效的 m3u8 地址。

## 技术栈
- Node.js 24+（线上 Vercel 使用 Node 26），内置 `http`/`https`/`fs`/`path` + `node:sqlite`
- 存储：PostgreSQL（`pg`，Vercel/Neon）优先；未配置连接串时回退本地 SQLite（`node:sqlite`，进程重启即丢失）
- 4K 站为 HTML 适配器解析，暴风站为 MacCMS JSON API
- 进程内 Map 缓存 + 数据库缓存：列表 15min、详情 30min、TVBox 配置 1h；过期目录先返回再后台刷新

## 目录结构
- `dyrs-vod-web/server.mjs`：全部路由与业务逻辑；默认导出 `requestHandler`，同时供本地 `http.createServer` 与 Vercel 函数调用
- `dyrs-vod-web/db-layer.mjs`：存储工厂 `initStores()`，优先级 postgres → sqlite；`DISABLE_DB=1` 可完全禁用
- `dyrs-vod-web/pg-store.mjs`：PostgreSQL 存储（自动建表，异步接口）
- `dyrs-vod-web/catalog-store.mjs`：本地 SQLite 影片、剧集元数据与查询快照；播放地址不入库
- `dyrs-vod-web/admin-store.mjs`：本地 SQLite 站点设置、广告位、卡密与管理员会话
- `dyrs-vod-web/sqlite-compat.mjs`：`node:sqlite` 驱动封装（pragma/exec/prepare/transaction）
- `dyrs-vod-web/public/`：前端静态页（`index.html`、`app.js`、`styles.css`、`admin.html`、`admin.js`、`admin.css`、`favicon.svg`）
- `dyrs-vod-web/vercel.json`：Vercel 入口（`server.mjs`）与 `public/**` 打包配置
- `dyrs-vod-web/build.sh`：构建到 `dist/`；`dyrs-vod-web/run.sh`：启动脚本（支持 `-p`，默认 `PORT=8000`）
- `.coze`：旧平台入口，仅作参考；正式部署走 Vercel

## 关键入口
- `/api/vod/list`、`/api/vod/search`、`/api/vod/detail`（别名 `/api.php/provide/vod`、`/vod`、`/`）：`ac=list|detail`、`t` 一级分类 1–5 或二级 MacCMS type_id（21/24/31/46…）、`year`、`wd`、`ids`；默认每页 40 条
- `/play.m3u8`、`/resolve`：同源播放链接（`?id=<id>&p=<sequence>`）与播放地址解析
- `/api/vod/tvbox`：TVBox 配置，线上正确端点（不是 `/tvbox.json`）
- `/api/site`、`/api/ads?slot=carousel|nav`：前台站点配置与广告位
- `/api/card/verify?code=`：卡密有效性校验（不自动核销）
- `/api/health`：健康检查

## 后台
- `/admin` 静态后台；接口前缀 `/api/admin/*`，Cookie 会话（`qy_admin`，HttpOnly，7 天）
- 数据库为空时用 `ADMIN_PASSWORD`（缺省 `admin123`）初始化密码；登录后应立即在「站点与授权」修改
- 广告位：`carousel` 最多 5 条（首页轮播），`nav` 为顶部导航广告条；仅启用且站点广告开关打开时前台展示
- 卡密：批量生成、状态筛选、停用/恢复、删除、导出 CSV；状态 `unused|used|disabled`
- 站点设置：站点名、副标题、公告、页脚、轮播间隔、广告总开关；保存后前台即时生效
- 后台修改类接口校验同源 Origin；未登录返回 401，前端自动回到登录页

## 统一故障链
- 目录、搜索、详情、播放解析统一顺序：`4kcz.com → czzy.top → cz4k.com → bfzy1.tv → bfzy2.tv → bfzy3.tv → bfzy4.tv → bfzy5.tv`
- 每个源总 Deadline 5 秒（`UPSTREAM_TIMEOUT_MS`，默认 5000），超时或异常立即切下一个源
- ID 约定：4K 为 `4kcz-N`，暴风为纯数字；两种 ID 不得传给对方适配器
- 4K 分类映射：电影 `/movie_bt_series/dyy`；电视剧合并 `/movie_bt_series/{guochanju,mj,hj,rj}`；动漫 `/movie_bt_view_cat/fjj`；默认 `/movie_bt`。综艺、短剧及 4K 无法表达的年份筛选直接回退暴风，不能忽略条件
- 4K 播放页失效时，用片名（NFKC/空白规范化后全等）+ 年份 + 集号/集名精确匹配暴风；歧义或缺集即失败，不取第一个模糊结果
- 全部失败：浏览器文档导航回 `/?error=playback` 并提示“所有播放源暂不可用”；API、TVBox、`/resolve` 返回 HTTP 502 JSON

## 环境变量
- `DATABASE_URL` / `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING`（或 `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`）：PostgreSQL 连接；Vercel + Neon 会自动注入
- `VOD_DB_PATH`：本地 SQLite 回退时的文件路径，默认 `dyrs-vod-web/data/catalog.db`
- `DISABLE_DB`：设为 `1` 时禁用数据库，全部请求实时回源，后台不可用
- `FOURKCZ_UPSTREAM_HOST`：4K 镜像列表，默认 `https://www.4kcz.com,https://4kcz.com,https://czzy.top,https://cz4k.com`
- `VOD_UPSTREAM_HOST`：暴风线路列表，默认 `bfzy1–5.tv`
- `UPSTREAM_TIMEOUT_MS`：单源总超时，默认 5000
- `UPSTREAM_MIN_INTERVAL_MS`：同一主机两次请求的最小间隔，默认 400（防风控）
- `UPSTREAM_COOLDOWN_MS`：主机失败后的冷却时间，默认 120000（2 分钟）
- `UPSTREAM_BLOCK_COOLDOWN_MS`：主机被拦截/停运后的冷却时间，默认 900000（15 分钟）
- `UPSTREAM_LIST_TTL_MS` / `UPSTREAM_DETAIL_TTL_MS`：列表/详情缓存与入库有效期，默认 900000 / 1800000
- `VOD_PAGE_SIZE`：前台/TVBox 列表每页条数，默认 40（10–100）
- `ADMIN_PASSWORD`：数据库为空时的初始管理员密码，默认 `admin123`
- `PUBLIC_URL`：对外域名，用于生成 TVBox api 与播放链接；未设置时按请求 Host 推断
- `PORT`：本地监听端口，默认 8000（Vercel 不使用）

## 上游采集节流
- 每个主机独立排队，同一主机请求间隔不小于 `UPSTREAM_MIN_INTERVAL_MS`，避免并发突发
- 列表缓存 15 分钟、详情缓存 30 分钟；相同 URL 的并发请求合并为一次上游抓取
- 每次真实采集（列表/搜索/详情/播放页）都立即写入数据库；Vercel 上过期缓存改为同步刷新，避免实例回收导致刷新结果丢失
- 4K 列表的多个栏目页、`ac=detail` 的详情补全都改为串行，不再一次性并发几十个请求
- 4K 站 WAF 会拦截 Node 默认 TLS 1.3 指纹，4K 请求固定使用 TLS 1.2，并优先直连 `www.4kcz.com`，避免 301 跳转吃掉 5 秒预算
- 返回停运/拦截/验证码页或请求失败的主机进入冷却期，期间直接跳过，由下一个镜像接管

## 运行与部署
- 本地启动：`cd dyrs-vod-web && npm install && npm start`（需 Node 24+）
- 构建：`bash dyrs-vod-web/build.sh` 输出到 `dist/`，并在产物目录安装生产依赖
- 线上：Vercel 项目 `quying-vod`，推送 `main` 自动部署，生产域名 `https://quying-vod.vercel.app`
- 数据库：Vercel Storage 的 Neon Postgres（`quying-db`），连接串由 Vercel 注入 `DATABASE_URL`
- Vercel 入口为 `server.mjs` 的默认导出，`vercel.json` 负责把 `public/**` 打进函数包

## 用户偏好与长期约束
- 源站停运、访问拦截、非 HTML、关键结构缺失一律视为故障并切换，绝不把错误页伪造成成功数据
- 播放器只提取 `mysvg` / `art.url` 字符串，不执行上游 JavaScript
- 播放/媒体/播放器 URL 只信任配置源站与可信 CDN（`py1080p.com`、`4kcz.com`、`czzy.top`、`cz4k.com`、`bytetos.com`、`bytedtos.com`），防 SSRF
- 保留 `v.fengbao14.com` 广告分片过滤（`/video/adjump/`），其他域名维持 302
- 存储层只保存目录、详情和剧集元数据，不保存上游播放页或短期 m3u8；`detailForPlay` 必须实时采集
- 只维护 PostgreSQL 与本地 SQLite 两种存储实现，不再新增其他数据库后端
