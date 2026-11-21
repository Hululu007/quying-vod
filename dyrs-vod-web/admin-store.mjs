// 趣影后台数据层：站点设置、广告位、卡密与管理员会话。
// 与目录库共用同一个 SQLite 文件，但独立建表，互不影响。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

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

function now() {
  return Date.now();
}

function str(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function randomCode(prefix = 'QY') {
  const seg = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  return `${prefix}-${seg()}-${seg()}-${seg()}`;
}

function hashPassword(password) {
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
  } catch {
    return false;
  }
}

export class AdminStore {
  constructor(filename, { initialPassword } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 2000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS ads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot TEXT NOT NULL DEFAULT 'carousel',
        title TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        sort INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS card_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        days INTEGER NOT NULL DEFAULT 30,
        status TEXT NOT NULL DEFAULT 'unused',
        note TEXT NOT NULL DEFAULT '',
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_status ON card_keys (status, id);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    const insertSetting = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

    const password = this.db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();
    if (!password || !password.value) {
      this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)")
        .run(hashPassword(initialPassword || 'admin123'));
    }
  }

  // ---- 设置 ----
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const result = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key === 'admin_password_hash') continue;
      result[row.key] = row.value;
    }
    return result;
  }

  updateSettings(patch = {}) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const tx = this.db.transaction((entries) => {
      for (const [key, value] of entries) stmt.run(key, str(value, 2000));
    });
    tx(Object.entries(patch).filter(([key]) => allowed.has(key)));
    return this.getSettings();
  }

  verifyPassword(password) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();
    return !!(row && verifyPassword(password, row.value));
  }

  setPassword(password) {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)")
      .run(hashPassword(password));
  }

  // ---- 会话 ----
  createSession(ttlMs = 7 * 24 * 3600 * 1000) {
    const token = crypto.randomBytes(24).toString('hex');
    const created = now();
    this.db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), created, created + ttlMs);
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(created);
    return token;
  }

  validateSession(token) {
    if (!token) return false;
    const row = this.db.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').get(tokenHash(token));
    return !!(row && row.expires_at > now());
  }

  destroySession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(tokenHash(token));
  }

  // ---- 广告 ----
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

  listAds(slot) {
    const where = slot && AD_SLOTS.has(slot) ? 'WHERE slot = ?' : '';
    const rows = this.db.prepare(`SELECT * FROM ads ${where} ORDER BY sort ASC, id ASC`).all(...(where ? [slot] : []));
    return rows.map((row) => ({
      id: row.id,
      slot: row.slot,
      title: row.title,
      image: row.image,
      link: row.link,
      sort: row.sort,
      enabled: !!row.enabled,
      createdAt: row.created_at,
    }));
  }

  publicAds(slot) {
    if (!this.getSettings().ads_enabled || this.getSettings().ads_enabled === '0') return [];
    const enabled = this.db.prepare('SELECT * FROM ads WHERE slot = ? AND enabled = 1 ORDER BY sort ASC, id ASC')
      .all(slot);
    const list = enabled.map((row) => ({ id: row.id, title: row.title, image: row.image, link: row.link }));
    return slot === 'carousel' ? list.slice(0, CAROUSEL_MAX) : list;
  }

  createAd(input) {
    const ad = this.normalizeAd(input);
    if (ad.slot === 'carousel') {
      const count = this.db.prepare("SELECT count(*) AS n FROM ads WHERE slot = 'carousel' AND enabled = 1").get().n;
      if (count >= CAROUSEL_MAX) throw new Error(`轮播广告最多 ${CAROUSEL_MAX} 条，请先停用或删除旧广告`);
    }
    const info = this.db.prepare('INSERT INTO ads (slot, title, image, link, sort, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ad.slot, ad.title, ad.image, ad.link, ad.sort, ad.enabled, now());
    return { id: info.lastInsertRowid, ...ad, enabled: !!ad.enabled };
  }

  updateAd(id, input) {
    const current = this.db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(id));
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
    this.db.prepare('UPDATE ads SET slot = ?, title = ?, image = ?, link = ?, sort = ?, enabled = ? WHERE id = ?')
      .run(ad.slot, ad.title, ad.image, ad.link, ad.sort, ad.enabled, Number(id));
    return { id: Number(id), ...ad, enabled: !!ad.enabled };
  }

  deleteAd(id) {
    return this.db.prepare('DELETE FROM ads WHERE id = ?').run(Number(id)).changes > 0;
  }

  // ---- 卡密 ----
  generateCards({ count, days, prefix, note } = {}) {
    const total = Math.max(1, Math.min(500, Math.trunc(Number(count) || 1)));
    const validDays = Math.max(1, Math.min(3650, Math.trunc(Number(days) || 30)));
    const safePrefix = str(prefix, 8).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'QY';
    const insert = this.db.prepare('INSERT INTO card_keys (code, days, status, note, created_at) VALUES (?, ?, ?, ?, ?)');
    const codes = [];
    const tx = this.db.transaction(() => {
      let guard = 0;
      while (codes.length < total && guard < total * 20) {
        guard += 1;
        const code = randomCode(safePrefix);
        try {
          insert.run(code, validDays, 'unused', str(note, 120), now());
          codes.push(code);
        } catch {
          // 极小概率重复，重新生成
        }
      }
    });
    tx();
    return codes;
  }

  listCards({ status, q, page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = [];
    if (CARD_STATUS.has(status)) { where.push('status = ?'); params.push(status); }
    const keyword = str(q, 40);
    if (keyword) { where.push('code LIKE ?'); params.push(`%${keyword.toUpperCase()}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = Math.max(1, Math.min(100, Math.trunc(Number(pageSize) || 20)));
    const current = Math.max(1, Math.trunc(Number(page) || 1));
    const total = this.db.prepare(`SELECT count(*) AS n FROM card_keys ${clause}`).get(...params).n;
    const rows = this.db.prepare(`SELECT * FROM card_keys ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, size, (current - 1) * size);
    return {
      total,
      page: current,
      pagecount: Math.max(1, Math.ceil(total / size)),
      list: rows.map((row) => ({
        id: row.id,
        code: row.code,
        days: row.days,
        status: row.status,
        note: row.note,
        usedAt: row.used_at,
        createdAt: row.created_at,
      })),
    };
  }

  exportCards() {
    return this.db.prepare('SELECT * FROM card_keys ORDER BY id DESC').all().map((row) => ({
      code: row.code,
      days: row.days,
      status: row.status,
      note: row.note,
      usedAt: row.used_at,
      createdAt: row.created_at,
    }));
  }

  setCardStatus(id, status) {
    if (!CARD_STATUS.has(status)) throw new Error('非法状态');
    return this.db.prepare('UPDATE card_keys SET status = ? WHERE id = ?').run(status, Number(id)).changes > 0;
  }

  deleteCard(id) {
    return this.db.prepare('DELETE FROM card_keys WHERE id = ?').run(Number(id)).changes > 0;
  }

  verifyCard(code) {
    const row = this.db.prepare('SELECT * FROM card_keys WHERE code = ?').get(str(code, 40).toUpperCase());
    if (!row) return { valid: false, reason: '卡密不存在' };
    if (row.status === 'disabled') return { valid: false, reason: '卡密已停用' };
    if (row.status === 'used') return { valid: false, reason: '卡密已使用' };
    return { valid: true, days: row.days };
  }

  // ---- 概览 ----
  overview() {
    const count = (sql) => {
      try { return this.db.prepare(sql).get().n; } catch { return 0; }
    };
    const cardStats = this.db.prepare("SELECT status, count(*) AS n FROM card_keys GROUP BY status").all();
    const cards = { unused: 0, used: 0, disabled: 0 };
    for (const row of cardStats) if (row.status in cards) cards[row.status] = row.n;
    return {
      vods: count('SELECT count(*) AS n FROM vods'),
      queries: count('SELECT count(*) AS n FROM queries'),
      ads: count('SELECT count(*) AS n FROM ads'),
      carousel: count("SELECT count(*) AS n FROM ads WHERE slot = 'carousel' AND enabled = 1"),
      navAds: count("SELECT count(*) AS n FROM ads WHERE slot = 'nav' AND enabled = 1"),
      cards,
      cardsTotal: cards.unused + cards.used + cards.disabled,
    };
  }
}

export { AD_SLOTS, CAROUSEL_MAX, DEFAULT_SETTINGS };
