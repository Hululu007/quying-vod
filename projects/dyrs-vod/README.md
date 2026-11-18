# 电影人生 VOD 接口

把 `https://dyrs360.cc/?sion_id=...` 适配为 TVBox / MacCMS 兼容的 JSON VOD 接口。服务只读取源站公开页面，不保存影片文件。

## 启动

```powershell
cd dyrs-vod
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

默认监听 `http://127.0.0.1:9978`。部署到公网时设置 `PUBLIC_URL`，例如 `https://vod.example.com`。

## 接口

```text
GET /api.php/provide/vod/?ac=list
GET /api.php/provide/vod/?ac=detail&t=1&pg=1
GET /api.php/provide/vod/?ac=detail&wd=太阳&pg=1
GET /api.php/provide/vod/?ac=detail&ids=movie-<24位ID>-<数字>
GET /resolve?path=/movie/<24位ID>/<数字>.html&origin=xiguam3u8&p=0
GET /api.php/provide/vod/?ac=detail&t=6k&pg=1
GET /api.php/provide/vod/?ac=detail&t=4k&pg=1
GET /api.php/provide/vod/?ac=detail&t=4k-movie&pg=1
GET /api.php/provide/vod/?ac=detail&t=4k-us&pg=1
GET /api.php/provide/vod/?ac=detail&ids=4kcz-24112
GET /collector/status
```

播放字段遵循苹果 CMS 约定：播放线路以 `$$$` 分组，剧集以 `#` 分隔，单集格式为 `名称$地址`。`vod_play_url` 中的地址指向本服务的 `/play.m3u8`，播放时才向源站读取短时有效的 m3u8 地址。

分类列表会附加 4K站首页及栏目：`4k` 综合首页、`4k-movie` 电影、`6k` 国产剧（兼容原 `/gcj` 入口）、`4k-us` 美剧、`4k-kr` 韩剧、`4k-jp` 日剧、`4k-anime` 动漫、`4k-preview` 预告。数据从 `https://www.4kcz.com/` 及其栏目页读取，影片详情使用 `4kcz-数字ID`。主源暂时不可用时，无参数总列表自动返回 4K站首页作为备用内容。

TVBox 配置：`GET /tvbox.json`。

## 配置

- `DYRS_BASE_URL`：主源地址，默认 `https://dyrs360.cc`
- `FOURKCZ_BASE_URL`：备用源地址，默认 `https://www.4kcz.com`
- `DYRS_SION_ID`：源站会话参数
- `PUBLIC_URL`：对外访问地址，用于生成播放链接
- `COLLECT_ENABLED`：是否启用每日自动采集，默认 `1`
- `COLLECT_INTERVAL_SECONDS`：采集间隔秒数，默认 `86400`（24 小时）
- `COLLECT_MAX_PAGES`：每个分类每日采集页数，默认 `3`，最大 `20`
- `COLLECT_DETAIL_LIMIT`：每个分类额外采集详情数，默认 `2`，设为 `0` 可关闭详情采集
- `COLLECT_RETRY_SECONDS`：一轮采集出错或未跑完后的重试间隔，默认 `600`（10 分钟）
- `UPSTREAM_RETRIES`：抓取超时/429/5xx 时的重试次数，默认 `2`
- `UPSTREAM_RETRY_BACKOFF_SECONDS`：首次重试等待秒数，默认 `1`（之后按指数翻倍）
- `COLLECT_CACHE_FILE`：本地 JSON 快照文件路径，默认项目目录下 `vod_collection.json`
- `COLLECT_S3_BACKUP`：是否把采集快照备份到对象存储，默认 `1`（`COZE_BUCKET_NAME` 存在时）
- `COLLECT_S3_PREFIX`：对象存储快照 key 前缀，默认 `dyrs-vod/collection`
- `COLLECT_S3_BACKUP_INTERVAL_SECONDS`：两次 S3 备份最小间隔，默认 `300`
- `HOST` / `PORT`：监听地址，默认 `0.0.0.0:9978`

服务启动后会检查快照；首次启动、快照未完整跑完或超过 24 小时时立即采集，之后每 24 小时运行一次；某一轮有抓取错误时按 `COLLECT_RETRY_SECONDS` 自动重试，不会把失败的一轮当成完整采集而空等一天。每个分类的列表落盘后会立刻补该分类的详情，重启后不必等全部列表跑完才出现选集数据。目录页和详情元数据保存在本地快照；播放地址仍在播放时实时解析。采集状态可通过 `GET /collector/status` 查看。

本地快照会备份到对象存储（需平台注入 `COZE_BUCKET_NAME`/`COZE_BUCKET_ENDPOINT_URL`，SDK 由平台预装）。本地文件缺失或重置时自动从对象存储恢复，避免部署环境重启后全量重采；备份失败不影响本地主流程。项目不接入数据库：数据是单一 JSON 快照、无实体关系与用户体系，对象存储已覆盖其持久化需求。

源站域名或页面结构变化时，接口会返回 JSON 错误并使用 HTTP 502，避免把 HTML 错误页伪装成成功数据。

搜索保留源站的模糊匹配结果，可能包含别名匹配。源站仅提供页数，`total` 为分页估计值，`total_is_estimate` 会标明这一点。播放依赖源站与媒体 CDN 的可用性，部分线路可能需要源站登录。每日采集默认覆盖每个分类前 3 页和前 2 部影片详情；可通过环境变量调整范围。
