// 趣影外部 MySQL 数据层：与 catalog-store.mjs / admin-store.mjs 保持相同的接口，
// 但全部方法为异步，供 server.mjs 统一 await。当 MYSQL_HOST 等环境变量配置时启用，
// 实现后台设置、广告、卡密、会话与目录缓存的跨实例/跨重启持久化。
import fs from 'node:fs';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vods (
  vod_id VARCHAR(64) PRIMARY KEY,
  source VARCHAR(16) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  name_key VARCHAR(255) NOT NULL DEFAULT '',
  type_id VARCHAR(16) NOT NULL DEFAULT '',
  year VARCHAR(16) NOT NULL DEFAULT '',
  area VARCHAR(64) NOT NULL DEFAULT '',
  payload_json MEDIUMTEXT NOT NULL,
  episodes_json MEDIUMTEXT NOT NULL,
  detail_ready TINYINT NOT NULL DEFAULT 0,
  fetched_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX idx_vods_name_key (name_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS queries (
  query_key VARCHAR(255) PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  page INT NOT NULL DEFAULT 1,
  pagecount INT NOT NULL DEFAULT 1,
  total INT NOT NULL DEFAULT 0,
  ids_json MEDIUMTEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(64) PRIMARY KEY,
  value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slot VARCHAR(16) NOT NULL DEFAULT 'carousel',
  title VARCHAR(80) NOT NULL DEFAULT '',
  image VARCHAR(800) NOT NULL DEFAULT '',
  link VARCHAR(800) NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS card_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  days INT NOT NULL DEFAULT 30,
  status VARCHAR(16) NOT NULL DEFAULT 'unused',
  note VARCHAR(120) NOT NULL DEFAULT '',
  used_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  INDEX idx_card_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS admin_sessions (
  token VARCHAR(64) PRIMARY KEY,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export function mysqlConfigured() {
  return Boolean(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE);
}

export function createMysqlPool() {
  const config = {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT) || 5,
    queueLimit: 0,
    charset: 'utf8mb4',
  };
  if (process.env.MYSQL_SSL === '1' || process.env.MYSQL_SSL_CA) {
    config.ssl = process.env.MYSQL_SSL_CA
      ? { ca: fs.readFileSync(process.env.MYSQL_SSL_CA), minVersion: 'TLSv1.2' }
      : { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
  }
  return mysql.createPool(config);
}

// ---------------- Catalog ----------------

export class MysqlCatalogStore {
  constructor(pool) {
    this.pool = pool;
  }

  async _q(sql, params = []) {
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  async initSchema() {
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await this.pool.query(stmt);
    }
  }

  async saveVod(row, ttl, time) {
    const id = text(row && row.vod_id);
    if (!id) return;
    const prevRows = await this._q('SELECT * FROM vods WHERE vod_id = ?', [id]);
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source = VALUES(source), name = VALUES(name), name_key = VALUES(name_key),
         type_id = VALUES(type_id), year = VALUES(year), area = VALUES(area),
         payload_json = VALUES(payload_json), episodes_json = VALUES(episodes_json),
         detail_ready = VALUES(detail_ready), fetched_at = VALUES(fetched_at), expires_at = VALUES(expires_at)`,
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
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const row of list) await this._saveVodConn(conn, row, ttl, time);
      await conn.query(
        `INSERT INTO queries (query_key, kind, page, pagecount, total, ids_json, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           kind = VALUES(kind), page = VALUES(page), pagecount = VALUES(pagecount),
           total = VALUES(total), ids_json = VALUES(ids_json),
           fetched_at = VALUES(fetched_at), expires_at = VALUES(expires_at)`,
        [
          key, key.split(':', 1)[0], Number(value && value.page) || 1,
          Number(value && value.pagecount) || 1, Number(value && value.total) || list.length,
          JSON.stringify(list.map((row) => text(row && row.vod_id)).filter(Boolean)), time, time + ttl,
        ],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async _saveVodConn(conn, row, ttl, time) {
    const id = text(row && row.vod_id);
    if (!id) return;
    const [prevRows] = await conn.query('SELECT * FROM vods WHERE vod_id = ?', [id]);
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
    await conn.query(
      `INSERT INTO vods (vod_id, source, name, name_key, type_id, year, area, payload_json, episodes_json, detail_ready, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source = VALUES(source), name = VALUES(name), name_key = VALUES(name_key),
         type_id = VALUES(type_id), year = VALUES(year), area = VALUES(area),
         payload_json = VALUES(payload_json), episodes_json = VALUES(episodes_json),
         detail_ready = VALUES(detail_ready), fetched_at = VALUES(fetched_at), expires_at = VALUES(expires_at)`,
      [
        id, id.startsWith('4kcz-') ? '4kcz' : 'bfzy', name, nameKey(name),
        text(payload.type_id), text(payload.vod_year), text(payload.vod_area),
        JSON.stringify(payload), JSON.stringify(storedEpisodes), detailReady ? 1 : 0, time, expiresAt,
      ],
    );
  }

  async getQuery(key) {
    const [rows] = await this.pool.query('SELECT * FROM queries WHERE query_key = ?', [key]);
    const query = rows[0];
    if (!query) return null;
    const ids = JSON.parse(query.ids_json);
    const list = [];
    for (const id of ids) {
      const [vrows] = await this.pool.query('SELECT * FROM vods WHERE vod_id = ?', [id]);
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
    const where = `name_key LIKE ? ESCAPE '\\\\'${withPlay ? " AND detail_ready = 1 AND episodes_json != '[]'" : ''}`;
    const params = [likePattern(key)];
    const [countRows] = await this.pool.query(`SELECT count(*) AS n FROM vods WHERE ${where}`, params);
    const total = countRows[0].n;
    const [rows] = await this.pool.query(
      `SELECT * FROM vods WHERE ${where}
       ORDER BY CASE WHEN name_key = ? THEN 0 ELSE 1 END, fetched_at DESC, vod_id
       LIMIT ? OFFSET ?`,
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

export class MysqlAdminStore {
  constructor(pool, { initialPassword } = {}) {
    this.pool = pool;
    this.initialPassword = initialPassword;
  }

  async _q(sql, params = []) {
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  async init() {
    const insertSetting = 'INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)';
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await this.pool.query(insertSetting, [key, value]);
    }
    const [pwRows] = await this.pool.query("SELECT value FROM settings WHERE `key` = 'admin_password_hash'");
    const password = pwRows[0];
    if (!password || !password.value) {
      await this.pool.query(
        "INSERT INTO settings (`key`, value) VALUES ('admin_password_hash', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        [hashPassword(this.initialPassword || 'admin123')],
      );
    }
  }

  async getSettings() {
    const rows = await this._q('SELECT `key`, value FROM settings');
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
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [key, value] of entries) {
        await conn.query("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [key, str(value, 2000)]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    return this.getSettings();
  }

  async verifyPassword(password) {
    const rows = await this._q("SELECT value FROM settings WHERE `key` = 'admin_password_hash'");
    const row = rows[0];
    return !!(row && verifyPassword(password, row.value));
  }

  async setPassword(password) {
    await this.pool.query("INSERT INTO settings (`key`, value) VALUES ('admin_password_hash', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [hashPassword(password)]);
  }

  async createSession(ttlMs = 7 * 24 * 3600 * 1000) {
    const token = crypto.randomBytes(24).toString('hex');
    const created = now();
    await this.pool.query('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)', [tokenHash(token), created, created + ttlMs]);
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at < ?', [created]);
    return token;
  }

  async validateSession(token) {
    if (!token) return false;
    const rows = await this._q('SELECT expires_at FROM admin_sessions WHERE token = ?', [tokenHash(token)]);
    const row = rows[0];
    return !!(row && row.expires_at > now());
  }

  async destroySession(token) {
    if (!token) return;
    await this.pool.query('DELETE FROM admin_sessions WHERE token = ?', [tokenHash(token)]);
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
    const where = slot && AD_SLOTS.has(slot) ? 'WHERE slot = ?' : '';
    const rows = await this._q(`SELECT * FROM ads ${where} ORDER BY sort ASC, id ASC`, where ? [slot] : []);
    return rows.map((row) => ({
      id: row.id, slot: row.slot, title: row.title, image: row.image, link: row.link,
      sort: row.sort, enabled: !!row.enabled, createdAt: row.created_at,
    }));
  }

  async publicAds(slot) {
    const settings = await this.getSettings();
    if (!settings.ads_enabled || settings.ads_enabled === '0') return [];
    const rows = await this._q('SELECT * FROM ads WHERE slot = ? AND enabled = 1 ORDER BY sort ASC, id ASC', [slot]);
    const list = rows.map((row) => ({ id: row.id, title: row.title, image: row.image, link: row.link }));
    return slot === 'carousel' ? list.slice(0, CAROUSEL_MAX) : list;
  }

  async createAd(input) {
    const ad = this.normalizeAd(input);
    if (ad.slot === 'carousel') {
      const rows = await this._q("SELECT count(*) AS n FROM ads WHERE slot = 'carousel' AND enabled = 1");
      if (rows[0].n >= CAROUSEL_MAX) throw new Error(`轮播广告最多 ${CAROUSEL_MAX} 条，请先停用或删除旧广告`);
    }
    const [result] = await this.pool.query('INSERT INTO ads (slot, title, image, link, sort, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [ad.slot, ad.title, ad.image, ad.link, ad.sort, ad.enabled, now()]);
    return { id: result.insertId, ...ad, enabled: !!ad.enabled };
  }

  async updateAd(id, input) {
    const cur = await this._q('SELECT * FROM ads WHERE id = ?', [Number(id)]);
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
    await this.pool.query('UPDATE ads SET slot = ?, title = ?, image = ?, link = ?, sort = ?, enabled = ? WHERE id = ?', [ad.slot, ad.title, ad.image, ad.link, ad.sort, ad.enabled, Number(id)]);
    return { id: Number(id), ...ad, enabled: !!ad.enabled };
  }

  async deleteAd(id) {
    const [result] = await this.pool.query('DELETE FROM ads WHERE id = ?', [Number(id)]);
    return result.affectedRows > 0;
  }

  async generateCards({ count, days, prefix, note } = {}) {
    const total = Math.max(1, Math.min(500, Math.trunc(Number(count) || 1)));
    const validDays = Math.max(1, Math.min(3650, Math.trunc(Number(days) || 30)));
    const safePrefix = str(prefix, 8).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'QY';
    const codes = [];
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      let guard = 0;
      while (codes.length < total && guard < total * 20) {
        guard += 1;
        const code = randomCode(safePrefix);
        try {
          await conn.query('INSERT INTO card_keys (code, days, status, note, created_at) VALUES (?, ?, ?, ?, ?)', [code, validDays, 'unused', str(note, 120), now()]);
          codes.push(code);
        } catch {
          // 极小概率重复，重新生成
        }
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    return codes;
  }

  async listCards({ status, q, page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = [];
    if (CARD_STATUS.has(status)) { where.push('status = ?'); params.push(status); }
    const keyword = str(q, 40);
    if (keyword) { where.push('code LIKE ?'); params.push(`%${keyword.toUpperCase()}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = Math.max(1, Math.min(100, Math.trunc(Number(pageSize) || 20)));
    const current = Math.max(1, Math.trunc(Number(page) || 1));
    const [countRows] = await this.pool.query(`SELECT count(*) AS n FROM card_keys ${clause}`, params);
    const total = countRows[0].n;
    const rows = await this._q(`SELECT * FROM card_keys ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, size, (current - 1) * size]);
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
    const [result] = await this.pool.query('UPDATE card_keys SET status = ? WHERE id = ?', [status, Number(id)]);
    return result.affectedRows > 0;
  }

  async deleteCard(id) {
    const [result] = await this.pool.query('DELETE FROM card_keys WHERE id = ?', [Number(id)]);
    return result.affectedRows > 0;
  }

  async verifyCard(code) {
    const rows = await this._q('SELECT * FROM card_keys WHERE code = ?', [str(code, 40).toUpperCase()]);
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
