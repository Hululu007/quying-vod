import fs from 'node:fs';
import path from 'node:path';
import Database from './sqlite-compat.mjs';

const MEDIA_RE = /\.(m3u8|mp4|m4v|mpd)(?:[?#]|$)/i;
const EPISODE_PAGE_RE = /^\/v_play\/[A-Za-z0-9_=-]+\.html$/;
const URL_FIELDS = /^(?:vod_(?:play|down)_(?:url|from|server|note))$/i;

function text(value) {
  return String(value == null ? '' : value);
}

function nameKey(value) {
  return text(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
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

function hasValue(value) {
  return value != null && value !== '' && (!Array.isArray(value) || value.length > 0);
}

function likePattern(value) {
  return `%${nameKey(value).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class CatalogStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 2000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vods (
        vod_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        name_key TEXT NOT NULL DEFAULT '',
        type_id TEXT NOT NULL DEFAULT '',
        year TEXT NOT NULL DEFAULT '',
        area TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        episodes_json TEXT NOT NULL DEFAULT '[]',
        detail_ready INTEGER NOT NULL DEFAULT 0,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vods_name_key ON vods(name_key);
      CREATE TABLE IF NOT EXISTS queries (
        query_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        page INTEGER NOT NULL DEFAULT 1,
        pagecount INTEGER NOT NULL DEFAULT 1,
        total INTEGER NOT NULL DEFAULT 0,
        ids_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.getVodStatement = this.db.prepare('SELECT * FROM vods WHERE vod_id = ?');
    this.getQueryStatement = this.db.prepare('SELECT * FROM queries WHERE query_key = ?');
    this.saveQueryStatement = this.db.prepare(`
      INSERT INTO queries (query_key, kind, page, pagecount, total, ids_json, fetched_at, expires_at)
      VALUES (@query_key, @kind, @page, @pagecount, @total, @ids_json, @fetched_at, @expires_at)
      ON CONFLICT(query_key) DO UPDATE SET
        kind = excluded.kind, page = excluded.page, pagecount = excluded.pagecount,
        total = excluded.total, ids_json = excluded.ids_json,
        fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    `);
    this.saveVodStatement = this.db.prepare(`
      INSERT INTO vods (
        vod_id, source, name, name_key, type_id, year, area, payload_json,
        episodes_json, detail_ready, fetched_at, expires_at
      ) VALUES (
        @vod_id, @source, @name, @name_key, @type_id, @year, @area, @payload_json,
        @episodes_json, @detail_ready, @fetched_at, @expires_at
      )
      ON CONFLICT(vod_id) DO UPDATE SET
        source = excluded.source, name = excluded.name, name_key = excluded.name_key,
        type_id = excluded.type_id, year = excluded.year, area = excluded.area,
        payload_json = excluded.payload_json, episodes_json = excluded.episodes_json,
        detail_ready = excluded.detail_ready, fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    `);
    this.saveTransaction = this.db.transaction((key, value, ttl, now) => {
      const list = Array.isArray(value && value.list) ? value.list : [];
      for (const row of list) this.saveVod(row, ttl, now);
      this.saveQueryStatement.run({
        query_key: key,
        kind: key.split(':', 1)[0],
        page: Number(value && value.page) || 1,
        pagecount: Number(value && value.pagecount) || 1,
        total: Number(value && value.total) || list.length,
        ids_json: JSON.stringify(list.map((row) => text(row && row.vod_id)).filter(Boolean)),
        fetched_at: now,
        expires_at: now + ttl,
      });
    });
  }

  saveVod(row, ttl, now) {
    const id = text(row && row.vod_id);
    if (!id) return;
    const previous = this.getVodStatement.get(id);
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
      (previous && previous.detail_ready) || storedEpisodes.length || (row.vod_content && row.vod_year)
    );
    const name = text(payload.vod_name);
    this.saveVodStatement.run({
      vod_id: id,
      source: id.startsWith('4kcz-') ? '4kcz' : 'bfzy',
      name,
      name_key: nameKey(name),
      type_id: text(payload.type_id),
      year: text(payload.vod_year),
      area: text(payload.vod_area),
      payload_json: JSON.stringify(payload),
      episodes_json: JSON.stringify(storedEpisodes),
      detail_ready: detailReady ? 1 : 0,
      fetched_at: now,
      expires_at: detailReady && previous && previous.detail_ready && !episodes.length
        ? Math.max(previous.expires_at, now + ttl)
        : now + ttl,
    });
  }

  rowToVod(row) {
    const payload = JSON.parse(row.payload_json);
    const groups = JSON.parse(row.episodes_json);
    const id = encodeURIComponent(row.vod_id);
    payload.vod_id = hasValue(payload.vod_id) ? payload.vod_id : row.vod_id;
    payload.vod_name = row.name;
    payload.type_id = row.type_id;
    payload.vod_year = row.year;
    payload.vod_area = row.area;
    payload.vod_play_from = groups.map((_group, index) => `趣影${index + 1}线`).join('$$$');
    payload.vod_play_url = groups.map((group) => group.map((episode) => (
      `${episode.name}$/play.m3u8?id=${id}&p=${episode.seq}`
    )).join('#')).join('$$$');
    return payload;
  }

  getQuery(key) {
    const query = this.getQueryStatement.get(key);
    if (!query) return null;
    const ids = JSON.parse(query.ids_json);
    const list = [];
    for (const id of ids) {
      const row = this.getVodStatement.get(id);
      if (!row) return null;
      list.push(this.rowToVod(row));
    }
    return {
      stale: query.expires_at <= Date.now(),
      value: {
        page: query.page,
        pagecount: query.pagecount,
        total: query.total,
        list,
      },
    };
  }

  saveQuery(key, value, ttl) {
    this.saveTransaction(key, value, ttl, Date.now());
  }

  searchVods(wd, page = 1, withPlay = false) {
    const limit = 20;
    const key = nameKey(wd);
    const where = `name_key LIKE ? ESCAPE '\\'${withPlay ? " AND detail_ready = 1 AND episodes_json != '[]'" : ''}`;
    const params = [likePattern(key)];
    const total = this.db.prepare(`SELECT count(*) AS n FROM vods WHERE ${where}`).get(...params).n;
    const rows = this.db.prepare(`
      SELECT * FROM vods WHERE ${where}
      ORDER BY CASE WHEN name_key = ? THEN 0 ELSE 1 END, fetched_at DESC, vod_id
      LIMIT ? OFFSET ?
    `).all(...params, key, limit, (page - 1) * limit);
    return {
      page,
      pagecount: Math.max(1, Math.ceil(total / limit)),
      total,
      list: rows.map((row) => this.rowToVod(row)),
    };
  }

  // 频道候选池：按服务端白名单规则从库内筛选完整候选（非单页），
  // 供 server.mjs 做频道快照的 localLoader；采集结果经 saveQuery 自动入库后这里会越来越丰富。
  channelVods(rule = {}) {
    const limit = Math.min(Math.max(Number(rule.limit) || 120, 1), 200);
    const score = `CAST(json_extract(payload_json,'$.vod_score') AS REAL)`;
    const hits = `CAST(json_extract(payload_json,'$.vod_hits') AS INTEGER)`;
    const actor = `json_extract(payload_json,'$.vod_actor')`;
    const where = [];
    const params = [];
    let order = `${score} DESC, vod_id ASC`;

    if (rule.kind === 'score') {
      where.push(`${score} > 0`);
    } else if (rule.kind === 'praise') {
      where.push(`${score} >= 6`);
      order = `${hits} DESC, vod_id ASC`;
    } else if (rule.kind === 'series') {
      const keywords = (rule.keywords || []).slice(0, 10);
      if (!keywords.length) return { page: 1, pagecount: 1, total: 0, list: [] };
      where.push(`(${keywords.map(() => `name_key LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      for (const kw of keywords) params.push(likePattern(kw));
    } else if (rule.kind === 'star' || rule.kind === 'guess') {
      const actors = (rule.actors || (rule.actor ? [rule.actor] : [])).slice(0, 6);
      const typeIds = rule.kind === 'guess' ? (rule.typeIds || []).slice(0, 8) : [];
      const or = [];
      for (const _ of actors) or.push(`${actor} LIKE ? ESCAPE '\\'`);
      for (const a of actors) params.push(likePattern(a));
      if (typeIds.length) {
        or.push(`type_id IN (${typeIds.map(() => '?').join(',')})`);
        for (const t of typeIds) params.push(text(t));
      }
      if (!or.length) return { page: 1, pagecount: 1, total: 0, list: [] };
      where.push(`(${or.join(' OR ')})`);
      const exclude = (rule.exclude || []).slice(0, 30);
      if (exclude.length) {
        where.push(`vod_id NOT IN (${exclude.map(() => '?').join(',')})`);
        for (const id of exclude) params.push(text(id));
      }
    } else if (rule.kind === 'guoman') {
      where.push(`(type_id = '40' OR (type_id IN ('4','41','42','43') AND area LIKE '%大陆%'))`);
    } else {
      return { page: 1, pagecount: 1, total: 0, list: [] };
    }

    const rows = this.db.prepare(`
      SELECT * FROM vods WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT ${limit}
    `).all(...params);
    return { page: 1, pagecount: 1, total: rows.length, list: rows.map((row) => this.rowToVod(row)) };
  }

  // 猜你喜欢的种子信息：仅取库内已有详情的演员与类型，库外 id 直接忽略。
  seedsInfo(ids) {
    const list = (Array.isArray(ids) ? ids : []).slice(0, 5).map(text).filter(Boolean);
    if (!list.length) return [];
    return this.db.prepare(`
      SELECT vod_id, type_id, json_extract(payload_json,'$.vod_actor') AS actor
      FROM vods WHERE vod_id IN (${list.map(() => '?').join(',')})
    `).all(...list);
  }

  close() {
    this.db.close();
  }
}

export function defaultDatabasePath(moduleDir) {
  const appRoot = path.basename(moduleDir) === 'dist' ? path.dirname(moduleDir) : moduleDir;
  return path.join(appRoot, 'data', 'catalog.db');
}
