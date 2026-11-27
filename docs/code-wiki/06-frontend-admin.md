# 06 · 前端与后台

前端位于 [public/](../../dyrs-vod-web/public)，是**零依赖、零构建**的原生 JavaScript 单页应用：

| 文件 | 职责 |
| --- | --- |
| [index.html](../../dyrs-vod-web/public/index.html) | 前台骨架：顶栏、导航、`#app` 容器、弹窗、页脚 |
| [app.js](../../dyrs-vod-web/public/app.js) | 前台全部逻辑（约 1650 行，IIFE） |
| [styles.css](../../dyrs-vod-web/public/styles.css) | 前台样式与响应式布局 |
| [admin.html](../../dyrs-vod-web/public/admin.html) | 后台骨架：登录页 + 侧边栏 + 内容区 |
| [admin.js](../../dyrs-vod-web/public/admin.js) | 后台全部逻辑（约 830 行） |
| [admin.css](../../dyrs-vod-web/public/admin.css) | 后台样式 |
| [favicon.svg](../../dyrs-vod-web/public/favicon.svg) | 站点图标 |

## 1. 前台 `app.js`

### 1.1 整体结构

```js
(() => {
  'use strict';
  // 1. 常量与状态
  // 2. 基础工具（el / clear / api / 卡密弹窗）
  // 3. 健康检查
  // 4. 影片网格 / 分页 / 分类 / 年份 / 榜单
  // 5. 首页（轮播、导航广告、推荐栏目）
  // 6. 搜索
  // 7. 浏览历史
  // 8. 创意频道
  // 9. 详情弹窗
  // 10. 直播
  // 11. TVBox / API 文档
  // 12. 路由与启动
})();
```

没有虚拟 DOM：所有视图都是 `el()` 创建真实 DOM 后挂载到 `#app`，切换视图时用 `clear()` 清空。

### 1.2 常量与状态

| 名称 | 内容 | 行号 |
| --- | --- | --- |
| `CATEGORIES` | 前台分类树（含二级分类） | [L10-42](../../dyrs-vod-web/public/app.js#L10-L42) |
| `RANKS` | 最新 / 最热 / 高分推荐（独立于一级分类） | [L45-49](../../dyrs-vod-web/public/app.js#L45-L49) |
| `YEARS` | 年份筛选项（含「更早」） | [L52-62](../../dyrs-vod-web/public/app.js#L52-L62) |
| `state` | 当前视图、分类、年份、分页、搜索词、列表等 | [L64](../../dyrs-vod-web/public/app.js#L64) |
| `bootParams` | 启动参数；识别 `?error=playback` 并清理 URL | [L65-71](../../dyrs-vod-web/public/app.js#L65-L71) |

### 1.3 基础工具

- `el(tag, attrs, children)`：[L74-87](../../dyrs-vod-web/public/app.js#L74-L87)
  - `class` → `className`；
  - `html` → `innerHTML`；
  - `on*` → `addEventListener`；
  - **显式排除 `false` 属性**，避免 `disabled: false` 导致按钮永久禁用。
- `clear(node)`：清空子节点。
- `api(path, opts)`：[L139-172](../../dyrs-vod-web/public/app.js#L139-L172)
  - 自动带卡密 `?code=`；
  - 30 秒 AbortController 超时；
  - 返回 401 时弹卡密输入框，保存到 `localStorage['qy_card_code']` 后重试一次；
  - 非 2xx 或 `{ ok:false }` 抛错。

### 1.4 卡密

| 名称 | 说明 | 行号 |
| --- | --- | --- |
| `qy_card_code` | localStorage 键 | [L91](../../dyrs-vod-web/public/app.js#L91) |
| `cardCode()` | 读取本地卡密 | [L92-94](../../dyrs-vod-web/public/app.js#L92-L94) |
| `withCode(path)` | 给本站 API 追加 `code` 参数 | [L95-100](../../dyrs-vod-web/public/app.js#L95-L100) |
| `showCardDialog(message)` | 自定义卡密输入弹窗（Promise） | [L101-137](../../dyrs-vod-web/public/app.js#L101-L137) |
| `injectCardButton()` | 授权模式下在顶栏注入「授权」入口；先调 `/api/card/verify` 校验，通过后才写入本地 | [L1608-1645](../../dyrs-vod-web/public/app.js#L1608-L1645) |

### 1.5 视图与路由

`setView(v)`（[L1591-1605](../../dyrs-vod-web/public/app.js#L1591-L1605)）支持：

| 视图 | 渲染函数 | 说明 |
| --- | --- | --- |
| `home` | `renderHome()` | 轮播 + 导航广告 + 推荐栏目 + 片库 |
| `search` | `renderSearch()` | 搜索框与结果 |
| `channels` | `renderChannels()` | 12 个创意频道卡片 |
| `live` | `renderLive()` | 直播分组、频道列表、播放器 |
| `tvbox` | `renderTvbox()` | 生成 TVBox 配置地址与使用说明 |
| `docs` | `renderDocs()` | API 文档（含频道与猜你喜欢 POST 说明） |

顶栏导航在 `index.html` 中通过 `data-view` 绑定：首页、频道、直播、TVBox、API（搜索栏位于轮播图下方，不在顶栏）。

### 1.6 首页

| 函数 | 作用 | 行号 |
| --- | --- | --- |
| `renderCarousel(host, items)` | 轮播图，自动切换、可手动控制 | [L353-410](../../dyrs-vod-web/public/app.js#L353-L410) |
| `loadHero(host)` | 请求 `/api/ads?slot=carousel` | [L411-435](../../dyrs-vod-web/public/app.js#L411-L435) |
| `loadNavAd()` | 顶部导航广告条（`slot=nav`，纯文字） | [L438-459](../../dyrs-vod-web/public/app.js#L438-L459) |
| `yearPills / rankPills` | 年份与榜单筛选按钮 | [L461-495](../../dyrs-vod-web/public/app.js#L461-L495) |
| `portalSection / loadPortalSection` | 首页各推荐栏目 + 「查看更多」 | [L496-525](../../dyrs-vod-web/public/app.js#L496-L525) |
| `loadChannelPreview` | 首页频道预览 | [L526-555](../../dyrs-vod-web/public/app.js#L526-L555) |

推荐内容来自 `/api/vod/kan?section=home|movie|tv|variety|anime`，失败时后端自动回退上游列表。

### 1.7 片库列表与分页

| 函数 | 说明 | 行号 |
| --- | --- | --- |
| `card(item)` | 单张影片卡片（海报、分类、地区、备注） | [L193-228](../../dyrs-vod-web/public/app.js#L193-L228) |
| `renderGrid()` | 40 条网格 | [L237-249](../../dyrs-vod-web/public/app.js#L237-L249) |
| `renderPager()` | 分页：第一页不显示「上一页」，末页不显示「下一页」 | [L250-264](../../dyrs-vod-web/public/app.js#L250-L264) |
| `loadListInto(wrap)` | 列表加载与错误/空态 | [L595-633](../../dyrs-vod-web/public/app.js#L595-L633) |
| `changePage(p)` | 翻页 | [L640-646](../../dyrs-vod-web/public/app.js#L640-L646) |

### 1.8 搜索

- `renderSearch()`：搜索框 + 结果容器；
- `doSearch()` / `doSearchInto(wrap)`：请求 `/api/vod/search?wd=`，空关键词不请求；
- 搜索时会把手动影片合并进第一页（后端 `publicListPayload` 处理）。

### 1.9 详情弹窗

- `openDetail(vodId)`：[L818-831](../../dyrs-vod-web/public/app.js#L818-L831)
  - 打开 `#modal`，先显示 spinner；
  - 请求 `/api/vod/detail?ids=`；
  - 成功后 `renderModal`，并把 id 写入浏览历史；
- `parsePlaySources(detail)`：[L803-816](../../dyrs-vod-web/public/app.js#L803-L816)
  - 按 `$$$` 拆 `vod_play_from` / `vod_play_url`；
  - 按 `#` 拆集，按 `名称$地址` 提取集名与地址；
  - 线路名缺省为「趣影一/二/…线」。
- `renderModal(d)`：[L833-871](../../dyrs-vod-web/public/app.js#L833-L871)
  - 海报、片名、类型/年份/地区/备注、简介；
  - 每个线路一个分组，点击集号 `window.open(ep.url)` 打开 `/play.m3u8?id=&p=`。

### 1.10 浏览历史与猜你喜欢

- `localStorage['qy_history']` 保存最近 20 条 `{ id }`；
- `historyIds(limit)` / `rememberHistory(id)`；
- 频道页的「猜你喜欢」通过 `POST /api/vod/channel?id=guess` 发送 `{ seeds, exclude }`，结果不写入共享缓存。

### 1.11 创意频道

- `renderChannels()`：12 个频道卡片（icon + 名称 + 简介）；
- `openChannel(c, pg)`：进入频道详情，复用网格与分页；
- `loadChannelInto(c, pg, wrap, hint)`：普通频道 GET，猜你喜欢 POST。

### 1.12 直播

直播播放器逻辑较复杂，单独见 [05-live-streaming.md](./05-live-streaming.md#7-前端直播视图)。核心函数：

`loadLiveGroups` / `loadLiveChannels` / `selectLiveChannel` / `startLivePlayback` / `loadLiveLine` / `ensureHls` / `videoCodecSupported` / `watchLiveFrames` / `noteLiveHealth`。

### 1.13 TVBox 与 API 文档

- `renderTvbox()`：[L1493-1537](../../dyrs-vod-web/public/app.js#L1493-L1537)
  - 展示 `/api/vod/tvbox` 地址；
  - 授权模式下提示需在地址后带 `?code=`；
  - 提供复制按钮。
- `renderDocs()`：[L1539-1589](../../dyrs-vod-web/public/app.js#L1539-L1589)
  - 列出主要 API、参数、示例；
  - 说明 TVBox 正确端点是 `/api/vod/tvbox`（不是 `/tvbox.json`）。

### 1.14 启动

`boot()`（[L1647+](../../dyrs-vod-web/public/app.js#L1647)）：

1. 调用 `/api/site` 加载站点名、副标题、公告、页脚；
2. 加载广告（轮播 + 导航）；
3. 绑定导航点击与 `hashchange`；
4. 首屏渲染首页；
5. 启动健康检查轮询。

## 2. 后台 `admin.js`

### 2.1 结构

后台是独立的单页应用，与前台共用同一个服务，但走 `/api/admin/*` 接口。

| 区域 | 行号 | 内容 |
| --- | --- | --- |
| 基础工具 | [L24-101](../../dyrs-vod-web/public/admin.js#L24-L101) | `el`、`toast`、`api`、`fmtTime`、`statCard`、`setHead` |
| 登录 | [L102-147](../../dyrs-vod-web/public/admin.js#L102-L147) | `checkSession`、`showLogin`、`showAdmin` |
| 导航 | [L148-178](../../dyrs-vod-web/public/admin.js#L148-L178) | `renderTab(name)` |
| 概览 | [L179-200](../../dyrs-vod-web/public/admin.js#L179-L200) | `renderOverview` |
| 广告位 | [L201-317](../../dyrs-vod-web/public/admin.js#L201-L317) | `adForm`、`renderAds` |
| 卡密 | [L318-462](../../dyrs-vod-web/public/admin.js#L318-L462) | 筛选、生成、表格、导出 |
| 手动影片 | [L463-603](../../dyrs-vod-web/public/admin.js#L463-L603) | 分类下拉、播放行编辑、表单 |
| 采集 | [L604-726](../../dyrs-vod-web/public/admin.js#L604-L726) | 采集状态、密钥、触发 |
| 站点与授权 | [L727-814](../../dyrs-vod-web/public/admin.js#L727-L814) | 站点设置、修改密码 |
| 启动 | [L815+](../../dyrs-vod-web/public/admin.js#L815) | 绑定登录/退出/tab |

### 2.2 登录态

- `checkSession()` 调 `GET /api/admin/session`；
- 未登录显示 `#loginView`，登录成功显示 `#adminView`；
- 接口返回 401 时自动回到登录页；
- 所有修改类请求都会带 `Origin`（浏览器自动），服务端做同源校验。

### 2.3 后台 tab

对应 `admin.html` 的 `data-tab`：

| tab | 内容 |
| --- | --- |
| `overview` | 影片、查询、广告、卡密统计 |
| `ads` | 轮播/导航广告增删改，最多各 5 条 |
| `cards` | 批量生成（天数 0 = 永久）、筛选、停用/恢复、删除、导出 CSV |
| `videos` | 手动添加影片：名称、分类、年份、地区、海报、简介、播放地址（每行 `集名|URL`） |
| `collect` | 查看采集游标/累计数量、生成采集密钥、立即采集 |
| `settings` | 站点名、副标题、公告、页脚、轮播间隔、广告总开关、屏蔽词、修改密码 |

## 3. 静态资源与缓存

### 3.1 版本号

`index.html` 与 `admin.html` 引用资源时带 `?v=YYYYMMDDx`：

```html
<link rel="stylesheet" href="/styles.css?v=20261123c" />
<script src="/app.js?v=20261123g" defer></script>
```

[`serveFile()`](../../dyrs-vod-web/server.mjs#L1913-L1926) 对带 `?v=` 的资源返回 `public, max-age=31536000, immutable`；HTML 始终 `no-cache`，保证新版本入口即时生效。

发布新版前端时**必须同时更新版本号**，否则边缘 CDN 可能继续返回旧资源。

### 3.2 Vercel 头配置

[vercel.json](../../dyrs-vod-web/vercel.json) 对 `app.js`、`styles.css`、`admin.js`、`admin.css` 设置一年 immutable 缓存，`favicon.svg` 一天。

## 4. DOM 契约

前台与后台的样式和脚本依赖以下固定 id/class，美化时可以改装饰样式，但**不要改契约**：

| 选择器 | 用途 |
| --- | --- |
| `#app` | 前台视图容器 |
| `#statusPill` | 健康状态 |
| `#modal`、`#modalCard` | 详情弹窗 |
| `#navAdBar` | 顶部导航广告 |
| `#loginView`、`#adminView` | 后台登录/主界面 |
| `#loginForm`、`#loginPassword`、`#loginErr` | 登录表单 |
| `#panel`、`#pageTitle`、`#pageSub` | 后台内容区 |
| `.nav-link[data-view]` | 前台导航 |
| `.side-link[data-tab]` | 后台导航 |
| `#toast` | 后台提示 |
