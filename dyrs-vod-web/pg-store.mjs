// 趣影外部 PostgreSQL 数据层：异步接口，表结构与本地 SQLite 版保持一致，
// 供 Vercel + Neon 等环境使用。连接串优先读 DATABASE_URL，其次 POSTGRES_URL / POSTGRES_URL_NON_POOLING；
// 也可用 PGHOST/PGUSER/PGPASSWORD/PGDATABASE 组合配置。
// 实现后台设置、广告、卡密、会话与目录缓存的跨实例/跨重启持久化。
import crypto from 'node:crypto';
import pg from 'pg';

// pg 默认把 BIGINT 解析成字符串；这里的时间戳都是 epoch 毫秒（安全整数范围内），
// 转成 number 以保持与 MySQL / SQLite 后端一致的返回类型。
pg.types.setTypeParser(20, (value) => Number(value));

const MEDIA_RE = /\.(m3u8|mp4|m4v|mpd)(?:[?#]|$)/i;
const EPISODE_PAGE_RE = /^\/v_play\/[A-Za-z0-9_=-]+\.html$/;
const URL_FIELDS = /^(?:vod_(?:play|down)_(?:url|from|server|note))$/i;

const DEFAULT_SETTINGS = {
  site_name: '趣影',
  site_subtitle: '高清影视 · 即搜即看',
  site_notice: '',
  footer_text: '本站仅聚合公开影视元数据与播放源信息，不存储任何影片文件。数据来源于公开接口，仅供学习交流。',
  ads_enabled: '1',
  carousel_interval: '5000',
};
const AD_SLOTS = new Set(['carousel', 'nav']);
const CAROUSEL_MAX = 5;
const CARD_STATUS = new Set(['unused', 'used', 'disabled']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function text(value) { return String(value == null ? '' : value); }
function str(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function nameKey(value) {
  return text(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
function now() { return Date.now(); }
function hasValue(value) {
  return value != null && value !== '' && (!Array.isArray(value) || value.length > 0);
}
function likePattern(value) {
  return `%${nameKey(value).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
function cleanPayload(row) {
  const payload = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (URL_FIELDS.test(key)) continue;
    payload[key] = value;
  }
  return payload;
}
function episodeGroups(playUrl) {
  const groups = [];
  let seq = 0;
  for (const raw of text(playUrl).split(/\${3,}/)) {
    const episodes = [];
    for (const pair of text(raw).split('#')) {
      const separator = pair.indexOf('$');
      if (separator < 0) continue;
      const url = pair.slice(separator + 1).trim();
      let episodePage = false;
      try { episodePage = EPISODE_PAGE_RE.test(new URL(url).pathname); } catch {}
      if (!url || (!MEDIA_RE.test(url) && !episodePage)) continue;
      episodes.push({ seq, name: pair.slice(0, separator) || '播放' });
      seq += 1;
    }
    if (episodes.length) groups.push(episodes);
  }
  return groups;
}
function rowToVod(row) {
  const payload = JSON.parse(row.payload_json);
  const groups = JSON.parse(row.episodes_json);
  const id = encodeURIComponent(row.vod_id);
  payload.vod_id = hasValue(payload.vod_id) ? payload.vod_id : row.vod_id;
  payload.vod_name = row.name;
  payload.type_id = row.type_id;
  payload.vod_year = row.year;
  payload.vod_area = row.area;
  payload.vod_play_from = groups.map((_g, i) => `趣影${i + 1}线`).join('$$$');
  payload.vod_play_url = groups.map((group) => group.map((ep) => `${ep.name}$/play.m3u8?id=${id}&p=${ep.seq}`).join('#')).join('$$$');
  return payload;
}
function randomCode(prefix = 'QY') {
  const seg = () => Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  return `${prefix}-${seg()}-${seg()}-${seg()}`;
}
function hashPassword(password) {
  // 与 admin-store.mjs 保持同格式：scrypt$salt$hash，避免迁移后旧密码失效。
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch { return false; }
}

// 逐条执行，避免依赖 multipleStatements；全部为幂等语句。
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vods (
     vod_id VARCHAR(64) PRIMARY KEY,
     source VARCHAR(16) NOT NULL,
     name VARCHAR(255) NOT NULL DEFAULT '',
     name_key VARCHAR(255) NOT NULL DEFAULT '',
     type_id VARCHAR(16) NOT NULL DEFAULT '',
     year VARCHAR(16) NOT NULL DEFAULT '',
     area VARCHAR(64) NOT NULL DEFAULT '',
     payload_json TEXT NOT NULL,
     episodes_json TEXT NOT NULL,
     detail_ready SMALLINT NOT NULL DEFAULT 0,
     fetched_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_vods_name_key ON vods (name_key)',
  `CREATE TABLE IF NOT EXISTS queries (
     query_key VARCHAR(255) PRIMARY KEY,
     kind VARCHAR(32) NOT NULL,
     page INT NOT NULL DEFAULT 1,
     pagecount INT NOT NULL DEFAULT 1,
     total INT NOT NULL DEFAULT 0,
     ids_json TEXT NOT NULL,
     fetched_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     "key" VARCHAR(64) PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ads (
     id BIGSERIAL PRIMARY KEY,
     slot VARCHAR(16) NOT NULL DEFAULT 'carousel',
     title VARCHAR(80) NOT NULL DEFAULT '',
     image VARCHAR(800) NOT NULL DEFAULT '',
     link VARCHAR(800) NOT NULL DEFAULT '',
     sort INT NOT NULL DEFAULT 0,
     enabled SMALLINT NOT NULL DEFAULT 1,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS card_keys (
     id BIGSERIAL PRIMARY KEY,
     code VARCHAR(64) NOT NULL UNIQUE,
     days INT NOT NULL DEFAULT 30,
     status VARCHAR(16) NOT NULL DEFAULT 'unused',
     note VARCHAR(120) NOT NULL DEFAULT '',
     used_at BIGINT NULL,
     created_at BIGINT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_card_status ON card_keys (status, id)',
  `CREATE TABLE IF NOT EXISTS admin_sessions (
     token VARCHAR(64) PRIMARY KEY,
     created_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
];

function connectionUrl() {
  return process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_URL_NON_POOLING
    || '';
}

export function postgresConfigured() {
  if (connectionUrl()) return true;
  return Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE);
}

// Neon 等托管数据库会主动断开空闲连接；不监听该事件会导致进程崩溃。
function attachIdleErrorHandler(pool) {
  pool.on('error', (error) => {
    console.warn('[quying] postgres pool error:', error && error.message ? error.message : error);
  });
  return pool;
}

export function createPostgresPool() {
  const url = connectionUrl();
  if (url) {
    return attachIdleErrorHandler(new pg.Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 8000,
    }));
  }
  const host = process.env.PGHOST;
  const config = {
    host,
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: Number(process.env.PG_CONNECTION_LIMIT) || 5,
    connectionTimeoutMillis: 8000,
  };
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(String(host || ''));
  config.ssl = local || process.env.PGSSL === '0' ? false : { rejectUnauthorized: false };
  return attachIdleErrorHandler(new pg.Pool(config));
}

// ---------------- Catalog ----------------

export class PgCatalogStore {
  constructor(pool) {
    this.pool = pool;
  }

  async _q(sql, params = []) {
    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async initSchema() {
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      for (const stmt of SCHEMA) await conn.query(stmt);
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
  }

  async saveVod(row, ttl, time) {
    const id = text(row && row.vod_id);
    if (!id) return;
    const prevRows = await this._q('SELECT * FROM vods WHERE vod_id = $1', [id]);
    const previous = prevRows[0];
    const previousPayload = previous ? JSON.parse(previous.payload_json) : {};
    const previousEpisodes = previous ? JSON.parse(previous.episodes_json) : [];
    const incoming = cleanPayload(row);
    const payload = { ...previousPayload };
    for (const [key, value] of Object.entries(incoming)) {
      if (hasValue(value) || !hasValue(payload[key])) payload[key] = value;
    }
    const episodes = episodeGroups(row.vod_play_url);
    const storedEpisodes = episodes.length ? episodes : previousEpisodes;
    const detailReady = Boolean(
      (previous && previous.detail_ready) || storedEpisodes.length || (row.vod_content && row.vod_year),
    );
    const name = text(payload.vod_name);
    const expiresAt = detailReady && previous && previous.detail_ready && !episodes.length
      ? Math.max(previous.expires_at, time + ttl)
      : time + ttl;
    await this.pool.query(
      `INSERT INTO vods (vod_id, source, name, name_key, type_id, year, area, payload_json, episodes_json, detail_ready, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (vod_id) DO UPDATE SET
         source = EXCLUDED.source, name = EXCLUDED.name, name_key = EXCLUDED.name_key,
         type_id = EXCLUDED.type_id, year = EXCLUDED.year, area = EXCLUDED.area,
         payload_json = EXCLUDED.payload_json, episodes_json = EXCLUDED.episodes_json,
         detail_ready = EXCLUDED.detail_ready, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
      [
        id, id.startsWith('4kcz-') ? '4kcz' : 'bfzy', name, nameKey(name),
        text(payload.type_id), text(payload.vod_year), text(payload.vod_area),
        JSON.stringify(payload), JSON.stringify(storedEpisodes), detailReady ? 1 : 0, time, expiresAt,
      ],
    );
  }

  async saveQuery(key, value, ttl) {
    const time = now();
    const list = Array.isArray(value && value.list) ? value.list : [];
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      for (const row of list) await this._saveVodConn(conn, row, ttl, time);
      await conn.query(
        `INSERT INTO queries (query_key, kind, page, pagecount, total, ids_json, fetched_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (query_key) DO UPDATE SET
           kind = EXCLUDED.kind, page = EXCLUDED.page, pagecount = EXCLUDED.pagecount,
           total = EXCLUDED.total, ids_json = EXCLUDED.ids_json,
           fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [
          key, key.split(':', 1)[0], Number(value && value.page) || 1,
          Number(value && value.pagecount) || 1, Number(value && value.total) || list.length,
          JSON.stringify(list.map((row) => text(row && row.vod_id)).filter(Boolean)), time, time + ttl,
        ],
      );
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
  }

  async _saveVodConn(conn, row, ttl, time) {
    const id = text(row && row.vod_id);
    if (!id) return;
    const prev = await conn.query('SELECT * FROM vods WHERE vod_id = $1', [id]);
    const previous = prev.rows[0];
    const previousPayload = previous ? JSON.parse(previous.payload_json) : {};
    const previousEpisodes = previous ? JSON.parse(previous.episodes_json) : [];
    const incoming = cleanPayload(row);
    const payload = { ...previousPayload };
    for (const [key, value] of Object.entries(incoming)) {
      if (hasValue(value) || !hasValue(payload[key])) payload[key] = value;
    }
    const episodes = episodeGroups(row.vod_play_url);
    const storedEpisodes = episodes.length ? episodes : previousEpisodes;
    const detailReady = Boolean(
      (previous && previous.detail_ready) || storedEpisodes.length || (row.vod_content && row.vod_year),
    );
    const name = text(payload.vod_name);
    const expiresAt = detailReady && previous && previous.detail_ready && !episodes.length
      ? Math.max(previous.expires_at, time + ttl)
      : time + ttl;
    await conn.query(
      `INSERT INTO vods (vod_id, source, name, name_key, type_id, year, area, payload_json, episodes_json, detail_ready, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (vod_id) DO UPDATE SET
         source = EXCLUDED.source, name = EXCLUDED.name, name_key = EXCLUDED.name_key,
         type_id = EXCLUDED.type_id, year = EXCLUDED.year, area = EXCLUDED.area,
         payload_json = EXCLUDED.payload_json, episodes_json = EXCLUDED.episodes_json,
         detail_ready = EXCLUDED.detail_ready, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
      [
        id, id.startsWith('4kcz-') ? '4kcz' : 'bfzy', name, nameKey(name),
        text(payload.type_id), text(payload.vod_year), text(payload.vod_area),
        JSON.stringify(payload), JSON.stringify(storedEpisodes), detailReady ? 1 : 0, time, expiresAt,
      ],
    );
  }

  async getQuery(key) {
    const rows = await this._q('SELECT * FROM queries WHERE query_key = $1', [key]);
    const query = rows[0];
    if (!query) return null;
    const ids = JSON.parse(query.ids_json);
    const list = [];
    for (const id of ids) {
      const vrows = await this._q('SELECT * FROM vods WHERE vod_id = $1', [id]);
      const v = vrows[0];
      if (!v) return null;
      list.push(rowToVod(v));
    }
    return {
      stale: query.expires_at <= Date.now(),
      value: { page: query.page, pagecount: query.pagecount, total: query.total, list },
    };
  }

  async searchVods(wd, page = 1, withPlay = false) {
    const limit = 20;
    const key = nameKey(wd);
    // PostgreSQL 的 LIKE 默认转义字符即反斜杠，与 likePattern 的转义方式一致。
    const where = `name_key LIKE $1${withPlay ? " AND detail_ready = 1 AND episodes_json != '[]'" : ''}`;
    const params = [likePattern(key)];
    const countRows = await this._q(`SELECT count(*) AS n FROM vods WHERE ${where}`, params);
    const total = countRows[0].n;
    const rows = await this._q(
      `SELECT * FROM vods WHERE ${where}
       ORDER BY CASE WHEN name_key = $2 THEN 0 ELSE 1 END, fetched_at DESC, vod_id
       LIMIT $3 OFFSET $4`,
      [...params, key, limit, (page - 1) * limit],
    );
    return {
      page,
      pagecount: Math.max(1, Math.ceil(total / limit)),
      total,
      list: rows.map(rowToVod),
    };
  }

  async close() {
    await this.pool.end();
  }
}

// ---------------- Admin ----------------

export class PgAdminStore {
  constructor(pool, { initialPassword } = {}) {
    this.pool = pool;
    this.initialPassword = initialPassword;
  }

  async _q(sql, params = []) {
    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async init() {
    const insertSetting = 'INSERT INTO settings ("key", value) VALUES ($1, $2) ON CONFLICT ("key") DO NOTHING';
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await this.pool.query(insertSetting, [key, value]);
    }
    const pwRows = await this._q('SELECT value FROM settings WHERE "key" = \'admin_password_hash\'');
    const password = pwRows[0];
    if (!password || !password.value) {
      await this.pool.query(
        'INSERT INTO settings ("key", value) VALUES (\'admin_password_hash\', $1) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
        [hashPassword(this.initialPassword || 'admin123')],
      );
    }
  }

  async getSettings() {
    const rows = await this._q('SELECT "key", value FROM settings');
    const result = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key === 'admin_password_hash') continue;
      result[row.key] = row.value;
    }
    return result;
  }

  async updateSettings(patch = {}) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      for (const [key, value] of entries) {
        await conn.query(
          'INSERT INTO settings ("key", value) VALUES ($1, $2) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
          [key, str(value, 2000)],
        );
      }
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
    return this.getSettings();
  }

  async verifyPassword(password) {
    const rows = await this._q('SELECT value FROM settings WHERE "key" = \'admin_password_hash\'');
    const row = rows[0];
    return !!(row && verifyPassword(password, row.value));
  }

  async setPassword(password) {
    await this.pool.query(
      'INSERT INTO settings ("key", value) VALUES (\'admin_password_hash\', $1) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
      [hashPassword(password)],
    );
  }

  async createSession(ttlMs = 7 * 24 * 3600 * 1000) {
    const token = crypto.randomBytes(24).toString('hex');
    const created = now();
    await this.pool.query('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), created, created + ttlMs]);
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at < $1', [created]);
    return token;
  }

  async validateSession(token) {
    if (!token) return false;
    const rows = await this._q('SELECT expires_at FROM admin_sessions WHERE token = $1', [tokenHash(token)]);
    const row = rows[0];
    return !!(row && row.expires_at > now());
  }

  async destroySession(token) {
    if (!token) return;
    await this.pool.query('DELETE FROM admin_sessions WHERE token = $1', [tokenHash(token)]);
  }

  normalizeAd(input = {}) {
    const slot = AD_SLOTS.has(input.slot) ? input.slot : 'carousel';
    const image = str(input.image, 800);
    const link = str(input.link, 800);
    if (image && !isHttpUrl(image)) throw new Error('图片地址必须是 http/https');
    if (link && !isHttpUrl(link) && !link.startsWith('/')) throw new Error('跳转链接必须是 http/https 或站内路径');
    return {
      slot,
      title: str(input.title, 80),
      image,
      link,
      sort: Number.isFinite(Number(input.sort)) ? Math.trunc(Number(input.sort)) : 0,
      enabled: input.enabled === false || input.enabled === 0 || input.enabled === '0' ? 0 : 1,
    };
  }

  async listAds(slot) {
    const where = slot && AD_SLOTS.has(slot) ? 'WHERE slot = $1' : '';
    const rows = await this._q(`SELECT * FROM ads ${where} ORDER BY sort ASC, id ASC`, where ? [slot] : []);
    return rows.map((row) => ({
      id: row.id, slot: row.slot, title: row.title, image: row.image, link: row.link,
      sort: row.sort, enabled: !!row.enabled, createdAt: row.created_at,
    }));
  }

  async publicAds(slot) {
    const settings = await this.getSettings();
    if (!settings.ads_enabled || settings.ads_enabled === '0') return [];
    const rows = await this._q('SELECT * FROM ads WHERE slot = $1 AND enabled = 1 ORDER BY sort ASC, id ASC', [slot]);
    const list = rows.map((row) => ({ id: row.id, title: row.title, image: row.image, link: row.link }));
    return slot === 'carousel' ? list.slice(0, CAROUSEL_MAX) : list;
  }

  async createAd(input) {
    const ad = this.normalizeAd(input);
    if (ad.slot === 'carousel') {
      const rows = await this._q("SELECT count(*) AS n FROM ads WHERE slot = 'carousel' AND enabled = 1");
      if (rows[0].n >= CAROUSEL_MAX) throw new Error(`轮播广告最多 ${CAROUSEL_MAX} 条，请先停用或删除旧广告`);
    }
    const result = await this.pool.query(
      'INSERT INTO ads (slot, title, image, link, sort, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [ad.slot, ad.title, ad.image, ad.link, ad.sort, ad.enabled, now()],
    );
    return { id: result.rows[0].id, ...ad, enabled: !!ad.enabled };
  }

  async updateAd(id, input) {
    const cur = await this._q('SELECT * FROM ads WHERE id = $1', [Number(id)]);
    const current = cur[0];
    if (!current) throw new Error('广告不存在');
    const merged = {
      slot: input.slot === undefined ? current.slot : input.slot,
      title: input.title === undefined ? current.title : input.title,
      image: input.image === undefined ? current.image : input.image,
      link: input.link === undefined ? current.link : input.link,
      sort: input.sort === undefined ? current.sort : input.sort,
      enabled: input.enabled === undefined ? !!current.enabled : input.enabled,
    };
    const ad = this.normalizeAd(merged);
    await this.pool.query('UPDATE ads SET slot = $1, title = $2, image = $3, link = $4, sort = $5, enabled = $6 WHERE id = $7', [ad.slot, ad.title, ad.image, ad.link, ad.sort, ad.enabled, Number(id)]);
    return { id: Number(id), ...ad, enabled: !!ad.enabled };
  }

  async deleteAd(id) {
    const result = await this.pool.query('DELETE FROM ads WHERE id = $1', [Number(id)]);
    return result.rowCount > 0;
  }

  async generateCards({ count, days, prefix, note } = {}) {
    const total = Math.max(1, Math.min(500, Math.trunc(Number(count) || 1)));
    const validDays = Math.max(1, Math.min(3650, Math.trunc(Number(days) || 30)));
    const safePrefix = str(prefix, 8).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'QY';
    const codes = [];
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      let guard = 0;
      while (codes.length < total && guard < total * 20) {
        guard += 1;
        const code = randomCode(safePrefix);
        // PostgreSQL 事务内唯一键冲突会中止整个事务，这里改用 ON CONFLICT 跳过重复。
        const inserted = await conn.query(
          'INSERT INTO card_keys (code, days, status, note, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING RETURNING code',
          [code, validDays, 'unused', str(note, 120), now()],
        );
        // 极小概率重复，未插入则重新生成
        if (inserted.rowCount > 0) codes.push(code);
      }
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
    return codes;
  }

  async listCards({ status, q, page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = [];
    if (CARD_STATUS.has(status)) { where.push(`status = $${params.length + 1}`); params.push(status); }
    const keyword = str(q, 40);
    if (keyword) { where.push(`code LIKE $${params.length + 1}`); params.push(`%${keyword.toUpperCase()}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = Math.max(1, Math.min(100, Math.trunc(Number(pageSize) || 20)));
    const current = Math.max(1, Math.trunc(Number(page) || 1));
    const countRows = await this._q(`SELECT count(*) AS n FROM card_keys ${clause}`, params);
    const total = countRows[0].n;
    const rows = await this._q(
      `SELECT * FROM card_keys ${clause} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (current - 1) * size],
    );
    return {
      total, page: current, pagecount: Math.max(1, Math.ceil(total / size)),
      list: rows.map((row) => ({
        id: row.id, code: row.code, days: row.days, status: row.status, note: row.note,
        usedAt: row.used_at, createdAt: row.created_at,
      })),
    };
  }

  async exportCards() {
    const rows = await this._q('SELECT * FROM card_keys ORDER BY id DESC');
    return rows.map((row) => ({
      code: row.code, days: row.days, status: row.status, note: row.note,
      usedAt: row.used_at, createdAt: row.created_at,
    }));
  }

  async setCardStatus(id, status) {
    if (!CARD_STATUS.has(status)) throw new Error('非法状态');
    const result = await this.pool.query('UPDATE card_keys SET status = $1 WHERE id = $2', [status, Number(id)]);
    return result.rowCount > 0;
  }

  async deleteCard(id) {
    const result = await this.pool.query('DELETE FROM card_keys WHERE id = $1', [Number(id)]);
    return result.rowCount > 0;
  }

  async verifyCard(code) {
    const rows = await this._q('SELECT * FROM card_keys WHERE code = $1', [str(code, 40).toUpperCase()]);
    const row = rows[0];
    if (!row) return { valid: false, reason: '卡密不存在' };
    if (row.status === 'disabled') return { valid: false, reason: '卡密已停用' };
    if (row.status === 'used') return { valid: false, reason: '卡密已使用' };
    return { valid: true, days: row.days };
  }

  async overview() {
    const count = async (sql) => {
      try { const rows = await this._q(sql); return rows[0].n; } catch { return 0; }
    };
    const cardStats = await this._q('SELECT status, count(*) AS n FROM card_keys GROUP BY status');
    const cards = { unused: 0, used: 0, disabled: 0 };
    for (const row of cardStats) if (row.status in cards) cards[row.status] = row.n;
    const [vods, queries, ads, carousel, navAds] = await Promise.all([
      count('SELECT count(*) AS n FROM vods'),
      count('SELECT count(*) AS n FROM queries'),
      count('SELECT count(*) AS n FROM ads'),
      count("SELECT count(*) AS n FROM ads WHERE slot = 'carousel' AND enabled = 1"),
      count("SELECT count(*) AS n FROM ads WHERE slot = 'nav' AND enabled = 1"),
    ]);
    return {
      vods, queries, ads, carousel, navAds, cards,
      cardsTotal: cards.unused + cards.used + cards.disabled,
    };
  }
}
