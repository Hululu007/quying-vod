// 数据层工厂：统一对外暴露异步接口。
// - 配置 DATABASE_URL / POSTGRES_URL / POSTGRES_URL_NON_POOLING（或 PG* 变量）时使用外部 PostgreSQL；
// - 否则回退到本地 SQLite（挂载在 Node 内置 node:sqlite 上，单进程、重启即丢失）。
// - 设置 DISABLE_DB=1 可完全禁用数据库，所有请求实时回源，后台功能不可用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export async function initStores({ initialPassword, moduleDir } = {}) {
  // 完全禁用数据库模式：不持久化、不缓存、后台不可用
  if (process.env.DISABLE_DB === '1') {
    throw new Error('Database disabled via DISABLE_DB=1');
  }

  // PostgreSQL 优先（Vercel + Neon 等托管环境），否则回退本地 SQLite。
  const { postgresConfigured, createPostgresPool, PgCatalogStore, PgAdminStore } = await import('./pg-store.mjs');
  if (postgresConfigured()) {
    const pool = createPostgresPool();
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

  // ---- SQLite 降级 ----
  // Node 22+ 才有 node:sqlite；低版本运行时给出可操作的错误，而不是裸的模块缺失
  let CatalogStore;
  let defaultDatabasePath;
  let AdminStore;
  try {
    ({ CatalogStore, defaultDatabasePath } = await import('./catalog-store.mjs'));
    ({ AdminStore } = await import('./admin-store.mjs'));
  } catch (error) {
    if (String(error?.code || error?.message || '').includes('node:sqlite')) {
      throw new Error('当前 Node 运行时不支持 node:sqlite：请配置 DATABASE_URL 使用 PostgreSQL，或设置 DISABLE_DB=1');
    }
    throw error;
  }
  const preferred = process.env.VOD_DB_PATH
    ? path.resolve(process.env.VOD_DB_PATH)
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
