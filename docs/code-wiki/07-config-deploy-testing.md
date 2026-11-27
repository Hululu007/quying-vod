# 07 · 配置、运行、部署与测试

## 1. 环境变量

### 1.1 存储

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | - | PostgreSQL 连接串（优先级最高） |
| `POSTGRES_URL` | - | Vercel + Neon 注入的连接串 |
| `POSTGRES_URL_NON_POOLING` | - | 非池化连接串 |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | - | 分项配置 PostgreSQL |
| `PG_CONNECTION_LIMIT` | `5` | 连接池大小 |
| `PGSSL` | 自动 | 设为 `0` 关闭 SSL；本机地址自动关闭 |
| `VOD_DB_PATH` | `dyrs-vod-web/data/catalog.db` | 本地 SQLite 文件路径 |
| `DISABLE_DB` | - | 设为 `1` 完全禁用数据库；后台不可用，全部实时回源 |

### 1.2 上游与采集

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FOURKCZ_UPSTREAM_HOST` | `https://www.4kcz.com,https://4kcz.com,https://czzy.top,https://cz4k.com` | 4K 镜像列表 |
| `VOD_UPSTREAM_HOST` | `https://bfzy1.tv,…,https://bfzy5.tv` | 暴风线路列表 |
| `UPSTREAM_TIMEOUT_MS` | `5000` | 单源总 Deadline |
| `UPSTREAM_MIN_INTERVAL_MS` | `400` | 同主机最小请求间隔（防风控） |
| `UPSTREAM_COOLDOWN_MS` | `120000` | 普通失败冷却 |
| `UPSTREAM_BLOCK_COOLDOWN_MS` | `900000` | 被拦截/停运冷却 |
| `UPSTREAM_LIST_TTL_MS` | `900000` | 列表缓存与入库有效期 |
| `UPSTREAM_DETAIL_TTL_MS` | `1800000` | 详情缓存与入库有效期 |
| `VOD_PAGE_SIZE` | `40` | 前台/TVBox 每页条数（10–100） |
| `DISABLE_IMAGE_PROXY` | - | 设为 `1` 关闭海报代理 |

### 1.3 站点与授权

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PUBLIC_URL` | 按请求 Host 推断 | 对外域名，用于生成播放链接与 TVBox api |
| `PORT` | `8000` | 本地监听端口（Vercel 不使用） |
| `ADMIN_PASSWORD` | `admin123` | 数据库为空时的初始管理员密码 |
| `REQUIRE_CARD` | - | 设为 `1` 开启卡密强制授权 |
| `VERCEL` | 平台注入 | 存在时不自行 `listen`，并使用同步刷新策略 |

### 1.4 直播

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LIVE_SOURCES` | `live.mjs` 内置列表 | 逗号分隔的自定义清单 URL，覆盖默认源 |
| `LIVE_FETCH_TIMEOUT_MS` | `20000` | 单个直播清单拉取超时 |
| `LIVE_CACHE_TTL_MS` | `21600000` | 直播快照有效期（6 小时） |
| `LIVE_COLD_WAIT_MS` | `8000` | 冷启动首个请求最多等待采集时间 |
| `LIVE_WARMUP` | 开启 | 设为 `0` 关闭启动预热 |
| `LIVE_DISABLE_LOCAL` | - | 设为 `1` 禁用 `assets/` 本地清单 |
| `ALLOW_LOCAL_PROXY` | - | 设为 `1` 允许代理 localhost（仅测试） |

## 2. 本地运行

### 2.1 前置条件

- Node.js ≥ 20（推荐 24+，`node:sqlite` 在 24+ 稳定）；
- 可选 PostgreSQL（不配置则自动使用 SQLite）。

### 2.2 启动

```bash
cd dyrs-vod-web
npm install
npm start
# 打开 http://localhost:8000
# 后台 http://localhost:8000/admin
```

SQLite 模式首次启动会在 `data/catalog.db` 自动建表；默认管理员密码 `admin123`（建议登录后立即修改）。

### 2.3 常用启动方式

```bash
PORT=8022 npm start
DISABLE_DB=1 npm start
DATABASE_URL=postgres://user:pass@host/db npm start
VOD_DB_PATH=/var/lib/quying/catalog.db npm start
```

`run.sh` 支持 `-p` 参数：

```bash
bash run.sh -p 8022
```

## 3. 构建与部署

### 3.1 本地构建 `build.sh`

[build.sh](../../dyrs-vod-web/build.sh)：

1. 切换到脚本目录；
2. 清空并创建 `dist/`；
3. 复制 `server.mjs`、`live.mjs`、`catalog-store.mjs`、`admin-store.mjs`、`pg-store.mjs`、`db-layer.mjs`、`sqlite-compat.mjs`、`package*.json`；
4. 复制 `public/`、`assets/`、`run.sh`；
5. 在 `dist/` 执行 `npm ci --omit=dev` 安装生产依赖。

```bash
bash dyrs-vod-web/build.sh
```

### 3.2 Vercel

- 入口：`server.mjs` 默认导出的 `requestHandler`；
- [vercel.json](../../dyrs-vod-web/vercel.json)：
  - `functions["server.mjs"].includeFiles` 打包 `public/**`、`assets/**`；
  - `maxDuration: 60`；
  - 静态资源长缓存头。
- 生产项目：`quying-vod`，推送 `main` 自动部署，域名 `https://quying-vod.vercel.app`。
- 数据库：Vercel Storage 的 Neon Postgres（`quying-db`），连接串由平台注入。

注意事项：

- Vercel 实例随时回收，过期缓存采用**同步刷新**（`process.env.VERCEL` 分支），确保采集结果落库；
- 直播在 Vercel 上每个实例都需重新冷启动，依赖 `LIVE_COLD_WAIT_MS` 占位 + 前端重试；
- 部署后若前端仍是旧版本，检查 HTML 引用的 `?v=` 是否已更新，必要时重新构建。

### 3.3 旧平台 `.coze`

[.coze](../../.coze) 是旧平台入口，仅作参考：

```toml
entrypoint = "dyrs-vod-web/server.mjs"
build = ["bash", "dyrs-vod-web/build.sh"]
run = ["bash", "dyrs-vod-web/run.sh", "-p", "8000"]
```

正式部署以 Vercel 为准。

### 3.4 GitHub Actions 定时采集

[.github/workflows/collect.yml](../../.github/workflows/collect.yml)：

- 每 10 分钟触发一次；
- 调用 `GET /api/admin/collect?token=<COLLECT_TOKEN>&pages=2`；
- 需要仓库 Secrets：`COLLECT_TOKEN`（后台「采集」页生成）、`SITE_URL`（可选，默认生产域名）。

采集游标保存在数据库 `settings.collect_cursor`，每次从上次位置继续，按分类分页推进。

## 4. 测试

测试使用 Node 内置 `node:test`，无需额外依赖。

```bash
cd dyrs-vod-web
node --test
```

| 测试文件 | 覆盖内容 |
| --- | --- |
| [http-compression.test.mjs](../../dyrs-vod-web/http-compression.test.mjs) | gzip 压缩、Vary、静态资源缓存头 |
| [live.test.mjs](../../dyrs-vod-web/live.test.mjs) | M3U 解析、IPv6 丢弃、默认源清单、同名合并、分类规则 |
| [live-api.test.mjs](../../dyrs-vod-web/live-api.test.mjs) | `/api/live/groups`、`/api/live/channels`、TVBox 直播配置 |
| [live-frontend.test.mjs](../../dyrs-vod-web/live-frontend.test.mjs) | 前端直播入口、HLS 播放器、编码预检、健康分、搜索防抖 |
| [live-proxy.test.mjs](../../dyrs-vod-web/live-proxy.test.mjs) | 分片 URL 改写、SSRF 拒绝、前端 HTTP 线路自动代理 |
| [live-refresh.test.mjs](../../dyrs-vod-web/live-refresh.test.mjs) | 精选清单解析/重写/顺序保持 |
| [live-timeout.test.mjs](../../dyrs-vod-web/live-timeout.test.mjs) | 持续慢速传输也受总超时约束 |

测试通常通过设置 `DISABLE_DB=1`、`VERCEL=1`、`LIVE_SOURCES=本地假源` 来隔离环境，再动态 `import('./server.mjs')` 启动临时服务。

## 5. 工具脚本

| 脚本 | 用法 | 输出 |
| --- | --- | --- |
| `tools/pick-live-sources.mjs` | `node tools/pick-live-sources.mjs [--via=https://...]` | `assets/weishi-live.m3u`、`assets/defang-live.m3u` |
| `tools/refresh-live-sources.mjs` | `node tools/refresh-live-sources.mjs [--dry-run]` | 原地重写 `assets/*-live.m3u` |
| `tools/live-reachability-probe.mjs` | `node tools/live-reachability-probe.mjs [--via=...]` | 终端表格 + `live-report.json` |
| `tools/verify-local-live.mjs` | `node tools/verify-local-live.mjs` | 本地清单识别结果 |

npm 脚本：

```bash
npm run live:refresh       # 自检并重写精选清单
npm run live:refresh:dry   # 只报告不写入
```

## 6. 常见问题排障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 列表/详情 502 | 所有上游失败或被冷却 | 查看日志中的 host 失败原因；等待冷却；检查源站是否停运 |
| 播放回首页并提示「所有播放源暂不可用」 | 4K 播放页失效且暴风无唯一匹配 | 正常降级行为；换片源或等待上游恢复 |
| 后台 503「数据库不可用」 | `DISABLE_DB=1` 或存储初始化失败 | 配置 `DATABASE_URL`，或移除 `DISABLE_DB` |
| 后台登录后马上失效 | 会话表被清理 / 密码已修改 | 重新登录；修改密码会强制下线 |
| 卡密 401 | 卡密停用/过期/未携带 | 检查 `?code=`、`X-Auth-Code`、`qy_card` Cookie |
| 直播一直 `collecting` | 首次采集超过 8 秒或全部源失败 | 等待重试；检查 `LIVE_SOURCES` 与出网 |
| 直播只有声音没画面 | H.265 编码 | 播放器会自动切线路；若全部线路 H.265 则无解 |
| HTTP 直播线路无法播放 | HTTPS 页面混合内容 | 前端自动走 `/live-proxy.m3u8`，检查代理是否可达 |
| 新版本页面没生效 | CDN 缓存旧资源 | 更新 `?v=` 版本号并重新部署 |
| SQLite 数据重启后丢失 | Vercel 无持久磁盘 | 使用 PostgreSQL |
| 4K 请求一直失败 | WAF 拦截 TLS 指纹 / IP 被风控 | 代码已固定 TLS 1.2；可调整镜像顺序或等待冷却 |

## 7. 仓库辅助文件

| 文件 | 说明 |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | 项目约定、环境变量、故障链、长期约束（修改代码前必读） |
| [.trae/documents/quying-sqlite-catalog.md](../../.trae/documents/quying-sqlite-catalog.md) | SQLite 片库接入方案（历史设计文档） |
| [.trae/documents/creative-channels.md](../../.trae/documents/creative-channels.md) | 创意频道实施方案（历史设计文档） |
| [.gitignore](../../.gitignore) | 忽略 `node_modules`、`dist`、`data/`、数据库 WAL、构建产物等 |
| `dyrs-vod-web/dist/` | `build.sh` 生成的部署产物，不应手工修改 |
| `dyrs-vod-web/data/` | 本地 SQLite 数据目录（不入库） |
