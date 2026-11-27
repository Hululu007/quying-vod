# 04 · 存储层

存储层负责四类数据：**目录快照**、**影片元数据**、**后台配置**、**卡密与会话**。播放地址与短期 m3u8 永远不落库。

## 1. 存储工厂 `db-layer.mjs`

[db-layer.mjs](../../dyrs-vod-web/db-layer.mjs) 只做一件事：根据环境选择后端并返回统一异步接口。

```js
const { catalogStore, adminStore, backend, close } = await initStores({
  initialPassword: process.env.ADMIN_PASSWORD,
  moduleDir: __dirname,
});
```

选择顺序（[L37-92](../../dyrs-vod-web/db-layer.mjs#L37-L92)）：

1. `DISABLE_DB=1` → 直接抛错，`server.mjs` 捕获后前后台降级，全部实时回源；
2. PostgreSQL 已配置（`postgresConfigured()`）→ `createPostgresPool()` + `PgCatalogStore.initSchema()` + `PgAdminStore.init()`；
3. 否则 → 本地 SQLite：
   - 动态导入 `catalog-store.mjs` / `admin-store.mjs`；
   - 数据库路径：`VOD_DB_PATH` 或 `defaultDatabasePath(moduleDir)`；
   - 目录不可写 → 回退 `os.tmpdir()/quying/catalog.db`；
   - 用 `wrapCatalogSync` / `wrapAdminSync` 把同步方法包装成异步接口。

`wrapAdminSync` 的暴露清单在 [L9-16](../../dyrs-vod-web/db-layer.mjs#L9-L16)，新增后台方法时需要同步补充。

## 2. 目录库（Catalog）

### 2.1 表结构

SQLite（[catalog-store.mjs L61-87](../../dyrs-vod-web/catalog-store.mjs#L61-L87)）与 PostgreSQL（[pg-store.mjs L138-198](../../dyrs-vod-web/pg-store.mjs#L138-L198)）保持一致：

```sql
-- 影片元数据
CREATE TABLE vods (
  vod_id        TEXT PRIMARY KEY,
  source        TEXT NOT NULL,           -- '4kcz' | 'bfzy'
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,           -- NFKC + 小写 + 压缩空白，用于搜索
  type_id       TEXT NOT NULL,
  year          TEXT NOT NULL,
  area          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,           -- 清洗后的 MacCMS 元数据
  episodes_json TEXT NOT NULL DEFAULT '[]', -- [[{seq,name}], ...]
  detail_ready  INTEGER NOT NULL DEFAULT 0,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- 查询快照
CREATE TABLE queries (
  query_key  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,              -- query_key 冒号前的前缀
  page       INTEGER NOT NULL,
  pagecount  INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  ids_json   TEXT NOT NULL,              -- 有序 vod_id 数组
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### 2.2 写入：`saveQuery(key, value, ttl)`

- 在一个事务里遍历 `value.list`，逐条 `saveVod`，再 upsert `queries`。
- `ids_json` 保存有序 ID，读取时按顺序还原列表，保证分页/排序稳定。

### 2.3 清洗与合并：`saveVod(row, ttl, now)`

清洗规则（SQLite/PG 相同）：

1. `cleanPayload()` 删除所有 `vod_play_url`、`vod_play_from`、`vod_down_*` 字段（正则 `URL_FIELDS`）。
2. `episodeGroups(vod_play_url)` 把上游 `$$$` 分组、`#` 集、`名称$地址` 拆成 `[[{seq,name}]]`：
   - 只保留媒体地址（`.m3u8/.mp4/.m4v/.mpd`）或 4K 剧集页（`/v_play/xxx.html`）；
   - **只保存集名和序号，不保存 URL**。
3. 与旧记录合并：新值非空才覆盖，避免精简列表把详情字段冲掉。
4. `detail_ready`：旧记录已完整、或本次有剧集、或本次同时有简介和年份 → 1。
5. `expires_at`：详情完整且本次没有剧集时取 `max(旧过期时间, now + ttl)`，避免详情被短 TTL 的列表提前覆盖。

### 2.4 读取：`rowToVod(row)`

[L164-178](../../dyrs-vod-web/catalog-store.mjs#L164-L178)：

- 恢复 `payload_json` 元数据；
- 用 `episodes_json` **重新生成**本站播放地址：
  - `vod_play_from`：`趣影1线$$$趣影2线…`；
  - `vod_play_url`：`集名$/play.m3u8?id=<urlencoded id>&p=<seq>#...`；
- 这样数据库里永远没有上游播放 URL，读出来也能直接给前端/TVBox 使用。

### 2.5 查询接口

| 方法 | 说明 | 实现 |
| --- | --- | --- |
| `getQuery(key)` | 取快照 + 按 ids 还原列表；返回 `{ stale, value }`；任一 vod 缺失返回 null | [SQLite L180-199](../../dyrs-vod-web/catalog-store.mjs#L180-L199) / [PG L374-390](../../dyrs-vod-web/pg-store.mjs#L374-L390) |
| `saveQuery(key, value, ttl)` | 事务写入快照与影片 | [SQLite L201-203](../../dyrs-vod-web/catalog-store.mjs#L201-L203) / [PG L308-335](../../dyrs-vod-web/pg-store.mjs#L308-L335) |
| `searchVods(wd, page, withPlay)` | 按 `name_key LIKE` 搜索，精确名优先，每页 20；`withPlay` 只取详情完整记录 | [SQLite L205-222](../../dyrs-vod-web/catalog-store.mjs#L205-L222) / [PG L392-412](../../dyrs-vod-web/pg-store.mjs#L392-L412) |
| `channelVods(rule)` | 频道候选池：按评分/热度/关键词/演员/国漫规则筛选，上限 120–200 | [SQLite L226-273](../../dyrs-vod-web/catalog-store.mjs#L226-L273) / [PG L416-458](../../dyrs-vod-web/pg-store.mjs#L416-L458) |
| `seedsInfo(ids)` | 取种子影片的 `type_id`、`vod_actor`，供猜你喜欢 | [SQLite L276-283](../../dyrs-vod-web/catalog-store.mjs#L276-L283) / [PG L460-468](../../dyrs-vod-web/pg-store.mjs#L460-L468) |

SQLite 用 `json_extract(payload_json, '$.vod_score')`，PostgreSQL 用 `payload_json::jsonb->>'vod_score'`；PG 版会先用正则 `^\d+(\.\d+)?$` 校验再转数值，避免脏数据导致 `::float` 报错。

### 2.6 查询键约定

查询键是快照缓存的主键，必须覆盖全部筛选条件：

| 类型 | 示例 |
| --- | --- |
| 列表 | `list:v5:<withPlay>:<pg>:<PAGE_SIZE>:<category>:<year>` |
| 豆瓣榜单 | `rank:douban:v2:<kind>:<year>` |
| 上游排序回退 | `rank:<kind>:v3:<withPlay>:<pg>:<PAGE_SIZE>:<year>` |
| 搜索 | `search:<withPlay>:<titleKey>:<pg>` |
| 详情 | `detail:<id1>,<id2>` |
| 频道 | `channel:<id>:v1:<CHANNEL_POOL_LIMIT>` |
| 360kan | `kan:v1:<section>:<limit>` |

`kind` 取冒号前第一段，便于统计与排查。

## 3. 后台库（Admin）

### 3.1 表结构

SQLite（[admin-store.mjs L98-133](../../dyrs-vod-web/admin-store.mjs#L98-L133)）与 PostgreSQL（[pg-store.mjs L164-197](../../dyrs-vod-web/pg-store.mjs#L164-L197)）：

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `settings` | `key`, `value` | 站点名、副标题、公告、页脚、广告开关、轮播间隔、屏蔽词、采集游标/密钥、管理员密码哈希 |
| `ads` | `id`, `slot`, `title`, `image`, `link`, `sort`, `enabled`, `created_at` | 轮播/导航广告 |
| `card_keys` | `id`, `code`, `days`, `status`, `note`, `used_at`, `created_at` | 卡密 |
| `admin_sessions` | `token`, `created_at`, `expires_at` | 管理员会话（token 存 sha256） |
| `manual_vods` | `vod_id`, `updated_at`, `payload` | 后台手动添加的影片 |

默认设置在 [`DEFAULT_SETTINGS`](../../dyrs-vod-web/admin-store.mjs#L8-L20)：站点名「趣影」、副标题、页脚声明、广告开启、轮播 5000ms、采集游标 `{"ci":0,"page":1}`。

### 3.2 管理员密码

- 存储格式：`scrypt$<salt>$<hash>`（Node `crypto.scryptSync`，64 字节）。
- 数据库无密码时用 `ADMIN_PASSWORD`（默认 `admin123`）初始化。
- `verifyPassword` 使用 `crypto.timingSafeEqual` 防时序攻击。

### 3.3 卡密语义

| 状态 | 含义 |
| --- | --- |
| `unused` | 未核销；首次授权时自动核销 |
| `used` | 已核销；有效期 = `used_at + days` 天，`days=0` 表示永久 |
| `disabled` | 已停用，永久无效 |

- [`assessCard(row, now)`](../../dyrs-vod-web/admin-store.mjs#L50-L62)：统一判定有效/过期/停用。
- [`verifyCard(code)`](../../dyrs-vod-web/admin-store.mjs#L378-L381)：只查不核销。
- [`authorizeCard(code)`](../../dyrs-vod-web/admin-store.mjs#L385-L401)：
  - 未核销 → `UPDATE ... WHERE code=? AND status='unused'` 条件更新；
  - 命中 0 行说明被并发抢先核销，重读后按有效期判定；
  - 保证并发场景只核销一次。
- 卡密格式：`<PREFIX>-XXXX-XXXX-XXXX`，字符集排除易混淆的 `I/O/0/1`。

### 3.4 广告规则

- slot 仅 `carousel` / `nav`。
- 轮播最多 5 条（`CAROUSEL_MAX`），导航最多 5 条（`NAV_MAX`）。
- `publicAds(slot)` 只在站点广告开关开启时返回启用项；轮播最多 5 条。

### 3.5 会话

- `createSession()` 生成 24 字节随机 token，数据库只存 sha256，7 天过期。
- `validateSession(token)` / `destroySession(token)` 对称处理。

### 3.6 手动影片

- `listManualVods()` / `saveManualVod(vod)` / `deleteManualVod(id)`。
- 数据以 JSON 存在 `manual_vods.payload`，`server.mjs` 的 `insights()` 缓存 30 秒。

## 4. PostgreSQL 实现 `pg-store.mjs`

[pg-store.mjs](../../dyrs-vod-web/pg-store.mjs) 是 SQLite 版的异步镜像：

- 连接串优先级：`DATABASE_URL` → `POSTGRES_URL` → `POSTGRES_URL_NON_POOLING`，或 `PGHOST/PGUSER/PGPASSWORD/PGDATABASE`。
- 连接池：`max=5`、`connectionTimeoutMillis=8000`；托管库默认 `ssl: { rejectUnauthorized: false }`，本机地址关闭 SSL。
- 监听 `pool.on('error')`，避免 Neon 主动断开空闲连接导致进程崩溃。
- `initSchema()` 在事务中逐条执行幂等 `SCHEMA`。
- 目录方法：`saveVod`、`saveQuery`、`getQuery`、`searchVods`、`channelVods`、`seedsInfo`。
- 后台方法：与 `AdminStore` 同名同语义，全部异步。
- `pg.types.setTypeParser(20, Number)` 把 BIGINT 时间戳转成 number，保持与 SQLite 返回类型一致。

## 5. SQLite 驱动封装 `sqlite-compat.mjs`

[sqlite-compat.mjs](../../dyrs-vod-web/sqlite-compat.mjs) 基于 Node 内置 `node:sqlite` 的 `DatabaseSync`，提供与 `better-sqlite3` 一致的接口：

| 方法 | 说明 |
| --- | --- |
| `pragma(stmt)` | 执行 `PRAGMA ...` |
| `exec(sql)` | 执行多语句 SQL |
| `prepare(sql)` | 返回 `run/get/all` 包装 |
| `transaction(fn)` | 返回事务包装函数（BEGIN/COMMIT/ROLLBACK） |
| `close()` | 关闭连接 |

因此本地不需要任何原生模块编译，Node 24+ 开箱即用。

## 6. 故障与降级

| 场景 | 行为 |
| --- | --- |
| `DISABLE_DB=1` | `initStores` 抛错，`catalogStore/adminStore=null`；前台实时回源，后台 503 |
| SQLite 目录不可写 | 回退系统临时目录；仍失败则存储初始化失败 |
| 数据库读写异常 | `catalogFailed()` 只打印一次警告；查询继续走实时路径 |
| PG 连接被断开 | 连接池错误被监听并记录，不崩溃 |
| 写库失败 | 刷新队列记录重试时间（`UPSTREAM_COOLDOWN_MS` 后重试），旧数据继续可用 |
| 快照中的 vod 缺失 | `getQuery` 返回 null，触发重新采集 |
