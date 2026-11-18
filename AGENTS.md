## 项目概述
把 `https://dyrs360.cc`（主源，电影人生）与 `https://www.4kcz.com`（备用源，4K站）公开网页适配为 TVBox / MacCMS 兼容的 JSON VOD 接口。服务只读取源站公开页面并做本地快照，不保存影片文件；播放时实时解析短时有效的 m3u8 地址。`project_type = "backend"`，不可预览。

## 技术栈
- Python 3.12（`.python-version`），Flask 3 + waitress 3 启动
- beautifulsoup4 解析源站 HTML，requests 抓取，缓存基于进程内 OrderedDict + 本地 JSON 快照
- 虚拟环境 `.venv` 由 `uv` 管理（requirements.txt），Node 侧不使用

## 目录结构
- `app.py`：全部路由与业务逻辑（760 行单体）
- `test_app.py`：unittest 单测（9 个用例，mock fetch/fetch_source）
- `vod_collection.json`：每日采集的本地快照（gitignore，不入库）
- `scripts/setup.sh` / `scripts/http_run.sh`：部署用的安装/启动包装（dyrs-vod 子目录）
- `.coze`：**根 `.coze` 在工作区根 `/workspace/projects/.coze`**（平台唯一入口），`[subprojects].path = ["projects/dyrs-vod"]`；子项目 `.coze` 在 `projects/dyrs-vod/.coze`（含 `sub_id`/`name`/`project_type`），多层结构
- 工作区根 = `/workspace/projects`（git 根），技术项目根 = `/workspace/projects/projects/dyrs-vod`

## 关键入口 / 核心模块
- `/vod`（含别名 `/api.php/provide/vod`、`/`）：列表/搜索/详情，`ac=list|detail`、`t` 分类（1/2/3/4/5 主源，4k/6k/4k-movie 等 4K站）、`wd` 搜索、`ids` 详情；`4kcz-数字ID` 走 4K站
- `/play.m3u8`、`/resolve`、`/4kcz/play`：播放地址实时解析
- `/tvbox.json`、`/collector/status`、`/health`：TVBox 配置、采集状态、健康检查
- 采集器：启动时 `start_collector()`（后台线程），按 `COLLECT_INTERVAL_SECONDS`（默认 86400）刷新快照；**一轮未完整跑完/出错按 `COLLECT_RETRY_SECONDS`（默认 600）短间隔重试，不空等一天**；抓取超时/429/5xx 由 `UPSTREAM_RETRIES`（默认 2）+ `UPSTREAM_RETRY_BACKOFF_SECONDS`（默认 1，指数退避）自动重试；配置项见 README（`DYRS_BASE_URL`、`FOURKCZ_BASE_URL`、`COLLECT_CACHE_FILE`、`COLLECT_S3_*`、`HOST`/`PORT` 等）
- 对外域名：部署时 `scripts/http_run.sh` 默认注入 `PUBLIC_URL=https://qw2y3rnk6x.coze.site`（`tvbox.json` 的 api 与播放链接基于它生成），外部环境变量可覆盖；本地未设置时 fallback 请求 Host
- 主源不可用降级：无参数总列表在主源失败时自动 fallback 4K站首页并附 `msg` 提示；有 `t` 分类或 `wd` 搜索时不降级、直接报错
- 快照备份：`save_collection` 后按 `COLLECT_S3_BACKUP_INTERVAL_SECONDS`（默认 300s）节流上传到平台对象存储（`COZE_BUCKET_*` 环境变量 + SDK 预装包 `coze_coding_dev_sdk`）；本地快照缺失时 `load_collection` 从对象存储恢复。备份失败仅记日志、不打断本地流程。**不接数据库**（单 JSON 快照无实体关系，对象存储已覆盖持久化）

## 运行与预览
- `project_type = "backend"`：`preview_enable = "disabled"`，无预览链路
- 本地验证：`cd dyrs-vod && uv pip install --python .venv/bin/python -r requirements.txt && COLLECT_CACHE_FILE=/tmp/empty_collection.json COLLECT_S3_BACKUP=0 .venv/bin/python -m unittest test_app`（`COLLECT_S3_BACKUP=0` 防止测试触发真实对象存储调用；`coze_coding_dev_sdk` 在系统 Python 的 dist-packages，venv 不安装）。uv 为 `--user` 安装（`~/.local/bin`），使用前 `export PATH="$HOME/.local/bin:$PATH"`
- 手动起服务：`.venv/bin/python app.py`（默认 `0.0.0.0:9978`，`PORT` 环境变量可改）；部署时固定端口 5000（`scripts/http_run.sh -p 5000`）
- 部署：`[deploy]` 指向 `scripts/setup.sh`（pip 安装 requirements.txt）与 `scripts/http_run.sh`，脚本内部按自身位置 fallback 回 dyrs-vod 根目录执行

## 用户偏好与长期约束
- 源站域名/页面结构变化时接口返回 JSON 错误 + HTTP 502，绝不把 HTML 错误页伪造成成功数据（`fetch` 校验 `<html` 与域名白名单）
- 播放/媒体/播放器 URL 只信任配置的源站和可信 CDN 域名（`py1080p.com`、`4kcz.com`、`bytetos.com` 等），防 SSRF
- 部署配置入口必须是脚本（`["bash", "..."]`），不用内联 `bash -c`；端口固定 5000

## 常见问题和预防
- **跑单测必须隔离采集快照**：工作区若存在真实 `vod_collection.json`，`collect_listing` 会命中缓存、不再调用被 mock 的 `fetch/fetch_source`，导致 `test_4kcz_listing_and_pagination`、`test_upstream_failure_is_json` 失败（表现为 200 而非 502、`fetch.call_args` 为 None）。用 `COLLECT_CACHE_FILE=/tmp/xxx.json` 指向**不存在**的空文件路径再跑测试（注意：测试自身会把 mock 数据写回该文件，两次跑之间残留会导致第二次命中缓存——跑完删掉或换个新路径），9 个用例全绿。
- **对象存储备份的 SDK 路径**：`coze_coding_dev_sdk` 是平台预装包（`/usr/local/lib/python3.12/dist-packages` 或部署环境注入），不在 requirements.txt、不可公网安装；本地实测 S3 功能需 `sys.path` 加系统 dist-packages 或用系统 python。SDK 上传会自动清洗文件名并附加随机后缀（如 `collection_8f3a2b1c.json`），恢复时用 `COLLECT_S3_PREFIX + '_'` 前缀列出、上传前先删旧对象保证桶内单份最新快照。
- venv 若为 Windows 产物（缺 `bin/python`），用 `UV_VENV_CLEAR=1 uv venv --python 3.12` 重建，勿手改。