// 数据层工厂：统一对外暴露异步接口。
// - 配置 DATABASE_URL / POSTGRES_URL / POSTGRES_URL_NON_POOLING（或 PG* 变量）时使用外部 PostgreSQL；
// - Cloudflare Workers 只支持 PostgreSQL（Hyperdrive 或 Neon 直连串），不做 SQLite 降级；
// - 本地 Node 未配置数据库时回退到 node:sqlite（单进程、重启即丢失）；
// - 设置 DISABLE_DB=1 可完全禁用数据库，所有请求实时回源，后台功能不可用。
const ADMIN_METHODS = [
  'getSettings', 'updateSettings', 'verifyPassword', 'setPassword',
  'createSession', 'validateSession', 'destroySession',
  'listAds', 'publicAds', 'createAd', 'updateAd', 'deleteAd',
  'generateCards', 'listCards', 'exportCards', 'setCardStatus', 'deleteCard',
  'verifyCard', 'authorizeCard', 'overview',
  'listManualVods', 'saveManualVod', 'deleteManualVod',
];

function wrapCatalogSync(sqlite) {
  return {
    getQuery: (key) => sqlite.getQuery(key),
    saveQuery: (key, value, ttl) => sqlite.saveQuery(key, value, ttl),
    searchVods: (wd, page, withPlay) => sqlite.searchVods(wd, page, withPlay),
    channelVods: (rule) => sqlite.channelVods(rule),
    seedsInfo: (ids) => sqlite.seedsInfo(ids),
    close: () => { try { sqlite.close(); } catch {} },
  };
}

function wrapAdminSync(sqlite) {
  const out = {};
  for (const method of ADMIN_METHODS) {
    out[method] = (...args) => sqlite[method](...args);
  }
  return out;
}

export async function initStores({ initialPassword, moduleDir, env = process.env } = {}) {
  // 完全禁用数据库模式：不持久化、不缓存、后台不可用
  if (String(env.DISABLE_DB) === '1') {
    throw new Error('Database disabled via DISABLE_DB=1');
  }

  const workers = typeof globalThis.__CF_ENV__ !== 'undefined';
  // PostgreSQL 优先；Workers 下这是唯一可用的后端。
  const { postgresConfigured, createPostgresPool, createWorkersPostgresStores, PgCatalogStore, PgAdminStore } = await import('./pg-store.mjs');

  if (workers) {
    return createWorkersPostgresStores(env, { initialPassword });
  }

  if (postgresConfigured(env)) {
    const pool = createPostgresPool(env);
    const catalogStore = new PgCatalogStore(pool);
    await catalogStore.initSchema();
    const adminStore = new PgAdminStore(pool, { initialPassword });
    await adminStore.init();
    return {
      catalogStore,
      adminStore,
      backend: 'postgres',
      close: async () => { try { await pool.end(); } catch {} },
    };
  }

  // ---- SQLite 降级（仅 Node）----
  const [{ default: fs }, { default: os }, { default: path }] = await Promise.all([
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  // Node 22+ 才有 node:sqlite；低版本运行时给出可操作的错误，而不是裸的模块缺失
  let CatalogStore;
  let defaultDatabasePath;
  let AdminStore;
  try {
    // 用变量形式做动态 import：Cloudflare 打包时不会把 node:sqlite 依赖带进 Workers 产物。
    const catalogModule = './catalog-store.mjs';
    const adminModule = './admin-store.mjs';
    ({ CatalogStore, defaultDatabasePath } = await import(catalogModule));
    ({ AdminStore } = await import(adminModule));
  } catch (error) {
    if (String(error?.code || error?.message || '').includes('node:sqlite')) {
      throw new Error('当前 Node 运行时不支持 node:sqlite：请配置 DATABASE_URL 使用 PostgreSQL，或设置 DISABLE_DB=1');
    }
    throw error;
  }
  const preferred = env.VOD_DB_PATH
    ? path.resolve(env.VOD_DB_PATH)
    : defaultDatabasePath(moduleDir);
  let databasePath = preferred;
  try {
    fs.mkdirSync(path.dirname(preferred), { recursive: true });
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    databasePath = preferred;
  } catch {
    databasePath = path.join(os.tmpdir(), 'quying', 'catalog.db');
  }
  const sqliteCatalog = new CatalogStore(databasePath);
  const adminStore = new AdminStore(databasePath, { initialPassword });
  return {
    catalogStore: wrapCatalogSync(sqliteCatalog),
    adminStore: wrapAdminSync(adminStore),
    backend: 'sqlite',
    databasePath,
    close: () => { try { sqliteCatalog.close(); } catch {} },
  };
}
