// 趣影 VOD 聚合服务：适配 4K 站（HTML）与暴风站（MacCMS JSON API），
// 输出统一的 TVBox / MacCMS 兼容接口。列表与详情来自上游公开页面，
// 播放地址实时解析且不落库；海报按需走同源代理。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

let catalogStore = null;
let adminStore = null;
try {
  const { initStores } = await import('./db-layer.mjs');
  const stores = await initStores({ initialPassword: process.env.ADMIN_PASSWORD, moduleDir: __dirname });
  catalogStore = stores.catalogStore;
  adminStore = stores.adminStore;
  if (stores.backend === 'postgres') {
    console.log('[quying] using external PostgreSQL for persistence');
  } else {
    console.warn('[quying] using local SQLite (non-persistent across restarts)');
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[quying] admin 默认密码 admin123，请登录 /admin 后立即修改');
    }
  }
} catch (error) {
  console.warn(`[quying] data store disabled: ${String(error.message || error)}`);
}

const PORT = Number(process.env.PORT) || 8000;
const HOST = '0.0.0.0';
// 暴风资源 mirrors are tried in order when a request fails or returns an
// abnormal response. A comma-separated VOD_UPSTREAM_HOST can override them.
const UPSTREAM_HOSTS = (process.env.VOD_UPSTREAM_HOST || 'https://bfzy1.tv,https://bfzy2.tv,https://bfzy3.tv,https://bfzy4.tv,https://bfzy5.tv')
  .split(',')
  .map((host) => host.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const FOURKCZ_HOSTS = (process.env.FOURKCZ_UPSTREAM_HOST || 'https://www.4kcz.com,https://4kcz.com,https://czzy.top,https://cz4k.com')
  .split(',')
  .map((host) => host.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const FOURKCZ_CATEGORY_PATHS = {
  '1': ['/movie_bt_series/dyy'],
  '2': ['/movie_bt_series/guochanju', '/movie_bt_series/mj', '/movie_bt_series/hj', '/movie_bt_series/rj'],
  '4': ['/movie_bt_view_cat/fjj'],
};
const PROVIDER_TYPES = {
  '1': { head: 20, children: [21, 22, 23, 24, 25, 26, 27, 28, 29, 50, 67] },
  '2': { head: 30, children: [31, 32, 33, 34, 35, 36, 37, 38] },
  '3': { head: 45, children: [46, 47, 48, 49] },
  '4': { head: 39, children: [40, 41, 42, 43, 44] },
  '5': { head: 58, children: [59, 60, 61, 62, 63, 64, 65, 66, 68] },
  '6': { head: 52, children: [52] },
  '7': { head: 53, children: [54, 55, 56, 57] },
};
// A head type maps to its headline id for 4K fallback and client display.
const HEAD_TO_HEADLINE = { 20: '1', 30: '2', 45: '3', 39: '4', 58: '5', 52: '6', 53: '7' };
// Child types map back to headline as well.
const CHILD_TO_HEADLINE = {};
for (const [hid, info] of Object.entries(PROVIDER_TYPES)) {
  for (const c of info.children) CHILD_TO_HEADLINE[c] = hid;
}
// MacCMS 原始 type_id → 显示中文名称（前端下拉/子分类展示用）
const TYPE_NAMES = {
  20: '电影片', 21: '动作片', 22: '喜剧片', 23: '恐怖片', 24: '科幻片', 25: '爱情片', 26: '剧情片', 27: '战争片', 28: '纪录片', 29: '理论片', 50: '动画片', 67: '福利',
  30: '连续剧', 31: '国产剧', 32: '欧美剧', 33: '香港剧', 34: '韩国剧', 35: '台湾剧', 36: '日本剧', 37: '海外剧', 38: '泰国剧',
  45: '综艺片', 46: '大陆综艺', 47: '港台综艺', 48: '日韩综艺', 49: '欧美综艺',
  39: '动漫片', 40: '国产动漫', 41: '日韩动漫', 42: '欧美动漫', 43: '港台动漫', 44: '海外动漫',
  58: '短剧大全', 59: '重生民国', 60: '穿越年代', 61: '现代言情', 62: '反转爽文', 63: '女恋总裁', 64: '闪婚离婚', 65: '都市脑洞', 66: '古装仙侠', 68: 'AI漫剧',
  52: '预告片', 53: '体育赛事', 54: '足球', 55: '篮球', 56: '网球', 57: '斯诺克',
};
// 4K 列表卡片的分类标签（.furk）与清晰度标签（.qb）。默认「全部」列表按
// 4K 站实际展示的分类标注，而不是把所有条目都归为电影。
const FOURK_CARD_TYPES = {
  '电影': 1, '1080P': 1, '720P': 1, '4K': 1, '高清': 1, '蓝光': 1,
  '动作片': 21, '喜剧片': 22, '恐怖片': 23, '科幻片': 24, '爱情片': 25, '剧情片': 26, '战争片': 27, '纪录片': 28, '动画片': 50,
  '国产剧': 31, '欧美剧': 32, '香港剧': 33, '港剧': 33, '韩国剧': 34, '韩剧': 34, '台湾剧': 35, '台剧': 35, '日本剧': 36, '日剧': 36, '海外剧': 37, '泰国剧': 38, '泰剧': 38,
  '综艺': 3, '综艺片': 45, '大陆综艺': 46, '港台综艺': 47, '日韩综艺': 48, '欧美综艺': 49,
  '动漫': 4, '动漫片': 39, '番剧': 41, '国产动漫': 40, '日韩动漫': 41, '欧美动漫': 42, '港台动漫': 43, '海外动漫': 44,
  '短剧': 5, '短剧大全': 58,
};
const FOURK_QUALITY_LABELS = new Set(['1080P', '720P', '4K', '高清', '蓝光']);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 5000;
const PAGE_SIZE = Math.max(10, Math.min(100, Number(process.env.VOD_PAGE_SIZE) || 40));
// Upstream providers cap every page at 20 rows regardless of the limit param.
const UPSTREAM_PAGE_SIZE = 20;
// Upstream sites rate-limit aggressive clients. Space requests per host, keep
// cached pages longer, and rest a failing host before touching it again.
const UPSTREAM_MIN_INTERVAL_MS = Math.max(0, Number(process.env.UPSTREAM_MIN_INTERVAL_MS ?? '400') || 0);
const UPSTREAM_COOLDOWN_MS = Math.max(0, Number(process.env.UPSTREAM_COOLDOWN_MS ?? '120000') || 0);
const UPSTREAM_BLOCK_COOLDOWN_MS = Math.max(0, Number(process.env.UPSTREAM_BLOCK_COOLDOWN_MS ?? '900000') || 0);
const IMAGE_PROXY_ENABLED = process.env.DISABLE_IMAGE_PROXY !== '1';
const PIC_KEYS = new Set(['vod_pic', 'vod_pic_slide', 'vod_pic_thumb']);
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const TTL = {
  list: Math.max(60000, Number(process.env.UPSTREAM_LIST_TTL_MS) || 900000),
  detail: Math.max(60000, Number(process.env.UPSTREAM_DETAIL_TTL_MS) || 1800000),
  tvbox: 3600000,
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Headline categories exposed by this site. The provider only tags leaves, so
// each headline category is the merge of its child type ids.
const CATEGORIES = [
  { id: 'new', name: '最新' },
  { id: 'hot', name: '最热' },
  { id: 'score', name: '高分推荐' },
  { id: '1', name: '电影' },
  { id: '2', name: '电视剧' },
  { id: '3', name: '综艺' },
  { id: '4', name: '动漫' },
  { id: '5', name: '短剧' },
  { id: '6', name: '预告片' },
  { id: '7', name: '体育' },
];
const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
const LEAF_TO_CATEGORY = new Map(Object.entries(CHILD_TO_HEADLINE));
const CLASSES = CATEGORIES.map((c) => ({ type_id: c.id, type_pid: 0, type_name: c.name, children: (PROVIDER_TYPES[c.id]?.children || []).map((tid) => ({ type_id: tid, type_pid: c.id, type_name: TYPE_NAMES[tid] || '' })) }));

// Poster CDN hosts observed on the resource API. Unlisted hosts are left
// untouched so the browser can load them directly.
const IMAGE_HOST_RES = [/(^|\.)bfp\d+\.com$/i, /(^|\.)sinaimg\.cn$/i, /(^|\.)tupian\.click$/i];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Public base URL for client-facing links. The upstream origin never leaks.
function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function imageHostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return IMAGE_HOST_RES.some((re) => re.test(h));
}

function proxyImage(raw, base) {
  if (!IMAGE_PROXY_ENABLED || !raw || typeof raw !== 'string') return raw;
  let u = raw.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  let parsed;
  try { parsed = new URL(u); } catch { return raw; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return raw;
  if (!imageHostAllowed(parsed.hostname)) return raw;
  return `${base}/img?url=${encodeURIComponent(u)}`;
}

function mapTypeId(tid) {
  return LEAF_TO_CATEGORY.get(String(tid)) || String(tid);
}

const MEDIA_RE = /\.(m3u8|mp4|m4v|mpd)(?:[?#]|$)/i;

// Keep only playable media groups; 4K episode pages are resolved on demand.
function playableGroups(playUrl, allowEpisodePages = false) {
  const groups = [];
  for (const raw of String(playUrl || '').split(/\${3,}/)) {
    const eps = [];
    for (const pair of String(raw).split('#')) {
      const idx = pair.indexOf('$');
      if (idx < 0) continue;
      const mediaUrl = pair.slice(idx + 1).trim();
      let episodePage = false;
      if (allowEpisodePages) {
        try { episodePage = /^\/v_play\/[A-Za-z0-9_=-]+\.html$/.test(new URL(mediaUrl).pathname); } catch {}
      }
      if (!mediaUrl || (!MEDIA_RE.test(mediaUrl) && !episodePage)) continue;
      eps.push({ name: pair.slice(0, idx) || '播放', url: mediaUrl });
    }
    if (eps.length) groups.push(eps);
  }
  return groups;
}

function rewritePlay(vod, base) {
  const groups = playableGroups(vod.vod_play_url, String(vod.vod_id || '').startsWith('4kcz-'));
  if (!groups.length) return { from: '趣影一线', url: '' };
  const id = encodeURIComponent(String(vod.vod_id || ''));
  let seq = 0;
  const urls = groups.map((eps) => eps.map((ep) => {
    const link = `${base}/play.m3u8?id=${id}&p=${seq}`;
    seq += 1;
    return `${ep.name}$${link}`;
  }).join('#'));
  const from = groups.map((_g, i) => `趣影${CN_NUM[i] || (i + 1)}线`).join('$$$');
  return { from, url: urls.join('$$$') };
}

// ---- 双源播放列表：暴风=趣影一线，4K=趣影二线 ----
const PAIR_TTL_MS = 1800000;
const pairCache = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function firstGroupUrl(v, base) {
  const play = rewritePlay(v, base);
  return play.url ? play.url.split('$$$')[0] : '';
}

async function counterpartUrl(v, base) {
  const isFourk = String(v.vod_id || '').startsWith('4kcz-');
  const name = String(v.vod_name || '').trim();
  const want = name.toLowerCase();
  if (!want) return '';
  const key = `${isFourk ? 'f' : 'b'}:${want}:${v.vod_year || ''}`;
  const hit = pairCache.get(key);
  if (hit && Date.now() - hit.at < PAIR_TTL_MS) return hit.url;
  let url = '';
  const sameYear = (it) => !v.vod_year || !it.vod_year || String(it.vod_year) === String(v.vod_year);
  try {
    if (!isFourk) {
      const res = await withTimeout(fetchFourkSearch(name, 1), 8000);
      const cand = (res.list || []).find((it) => String(it.vod_name || '').trim().toLowerCase() === want && sameYear(it));
      if (cand) {
        const rows = await withTimeout(fetchFourkDetail(String(cand.vod_id)), 8000);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) url = firstGroupUrl(row, base);
      }
    } else {
      const data = await withTimeout(fetchBfzySearch(name, 1, true), 8000);
      const cand = (data.list || []).find((it) => String(it.vod_name || '').trim().toLowerCase() === want && sameYear(it));
      if (cand) url = firstGroupUrl(cand, base);
    }
  } catch {
    url = '';
  }
  pairCache.set(key, { at: Date.now(), url });
  return url;
}

async function withPlaySources(v, base) {
  if (!v || typeof v !== 'object' || String(v.vod_id || '').startsWith('manual-')) return v;
  const isFourk = String(v.vod_id || '').startsWith('4kcz-');
  const own = firstGroupUrl(v, base);
  const other = await counterpartUrl(v, base);
  const groups = [];
  if (isFourk) {
    if (other) groups.push({ from: '趣影一线', url: other });
    if (own) groups.push({ from: '趣影二线', url: own });
  } else {
    if (own) groups.push({ from: '趣影一线', url: own });
    if (other) groups.push({ from: '趣影二线', url: other });
  }
  if (!groups.length) return v;
  if (!other) groups[0].from = isFourk ? '趣影二线' : '趣影一线';
  return { ...v, __play: { from: groups.map((g) => g.from).join('$$$'), url: groups.map((g) => g.url).join('$$$') } };
}

// Normalise one upstream record into our public shape.
function normalizeItem(v, base, withPlay) {
  if (!v || typeof v !== 'object') return null;
  // Keep the original MacCMS type_id for client-side filtering, but show a
  // human-readable Chinese name (supports both headline ids and raw sub-type ids).
  const rawId = String(v.type_id || '');
  const item = { ...v };
  item.type_id = rawId;
  // 上游自带分类名时优先展示（4K 列表即为站点卡片上的原始标签）。
  item.type_name = v.type_name || categoryName(rawId) || '';
  for (const key of PIC_KEYS) if (typeof item[key] === 'string') item[key] = proxyImage(item[key], base);
  // 手动添加的影片直接使用后台填写的播放地址，不走上游播放页改写。
  const isManual = String(v.vod_id || '').startsWith('manual-');
  const play = withPlay && v.__play
    ? v.__play
    : withPlay && isManual
      ? { from: v.vod_play_from || '手动线路', url: v.vod_play_url || '' }
      : withPlay ? rewritePlay(v, base) : { from: '趣影一线', url: '' };
  delete item.__play;
  item.vod_play_from = play.from;
  item.vod_play_url = play.url;
  return item;
}

function httpGetText(target, opts = {}) {
  return new Promise((resolveRequest) => {
    let settled = false;
    const resolve = (value) => {
      if (settled) return;
      settled = true;
      resolveRequest(value);
    };
    let parsed;
    try { parsed = new URL(target); } catch { resolve({ status: 0, error: 'invalid url' }); return; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolve({ status: 0, error: 'invalid protocol' });
      return;
    }
    const remaining = opts.deadline ? opts.deadline - Date.now() : (opts.timeout || UPSTREAM_TIMEOUT_MS);
    if (remaining <= 0) { resolve({ status: 0, error: 'upstream timeout' }); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    // 4K 站点的 WAF 会拦截 Node 的 TLS 1.3 指纹，强制 TLS 1.2 才能拿到正常页面。
    const tlsOptions = parsed.protocol === 'https:' && opts.tls12
      ? { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }
      : {};
    const req = lib.get(parsed, { headers: opts.headers || {}, family: 4, ...tlsOptions }, (resp) => {
      const status = resp.statusCode || 0;
      const location = resp.headers.location;
      if (opts.followRedirects && location && status >= 300 && status < 400) {
        let next;
        try { next = new URL(location, parsed); } catch {
          resp.resume();
          resolve({ status: 0, error: 'invalid redirect' });
          return;
        }
        const redirects = (opts.redirects || 0) + 1;
        const allowed = opts.redirectAllowed ? opts.redirectAllowed(next) : next.origin === parsed.origin;
        // 不要 destroy：销毁请求会触发 error 事件，抢在重定向结果前把 Promise 判为失败。
        resp.resume();
        if (redirects > 3 || !allowed) { resolve({ status: 0, error: 'redirect not allowed' }); return; }
        resolve(httpGetText(next.toString(), { ...opts, redirects }));
        return;
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({
        status,
        headers: resp.headers || {},
        body: Buffer.concat(chunks),
      }));
      resp.on('error', (e) => resolve({ status: 0, error: String((e && e.message) || e) }));
    });
    req.on('error', (e) => resolve({ status: 0, error: String((e && e.message) || e) }));
    req.setTimeout(Math.min(opts.timeout || UPSTREAM_TIMEOUT_MS, remaining), () => req.destroy(new Error('upstream timeout')));
  });
}

// Build an upstream query string. The resource site sits behind a WAF rule
// that rejects literal "wd=", so the search key is sent percent-encoded.
function buildQuery(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const key = k === 'wd' ? '%77%64' : encodeURIComponent(k);
    parts.push(`${key}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

const jsonCache = new Map();
const inflightJson = new Map();
const hostSlots = new Map();
const hostCooldowns = new Map();

// Serialize requests to the same upstream host so a burst never leaves at once.
function hostSlot(key) {
  if (!UPSTREAM_MIN_INTERVAL_MS) return Promise.resolve();
  const now = Date.now();
  const start = Math.max(now, hostSlots.get(key) || 0);
  hostSlots.set(key, start + UPSTREAM_MIN_INTERVAL_MS);
  const wait = start - now;
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function hostCooling(key) {
  const until = hostCooldowns.get(key) || 0;
  if (!until) return false;
  if (until > Date.now()) return true;
  hostCooldowns.delete(key);
  return false;
}

function coolHost(key, ms) {
  if (ms > 0) hostCooldowns.set(key, Date.now() + ms);
}

function upstreamFailure(message, { blocked = false } = {}) {
  const error = new Error(message);
  error.hostCool = true;
  error.blocked = blocked;
  return error;
}

async function upstreamJson(params, ttl) {
  const qs = buildQuery(params);
  const cacheKey = `bfzy:${qs}`;
  const now = Date.now();
  const hit = jsonCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  const running = inflightJson.get(cacheKey);
  if (running) return running;

  const task = (async () => {
    let lastError = null;
    for (const baseHost of UPSTREAM_HOSTS) {
      if (hostCooling(baseHost)) continue;
      await hostSlot(baseHost);
      const r = await httpGetText(`${baseHost}/api.php/provide/vod/?${qs}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json,*/*', 'Accept-Encoding': 'identity', Referer: `${baseHost}/` },
        timeout: UPSTREAM_TIMEOUT_MS,
      });
      let data = null;
      if (!r.error && r.status >= 200 && r.status < 300) {
        try { data = JSON.parse(r.body.toString('utf8')); } catch {}
      }
      if (!data || typeof data !== 'object') {
        lastError = upstreamFailure('bfzy provider unavailable');
        coolHost(baseHost, UPSTREAM_COOLDOWN_MS);
        continue;
      }
      if (ttl > 0) {
        jsonCache.set(cacheKey, { expires: Date.now() + ttl, value: data });
        if (jsonCache.size > 400) {
          for (const [k, v] of jsonCache) if (v.expires <= Date.now()) jsonCache.delete(k);
        }
      }
      return data;
    }
    throw lastError || new Error('all upstream providers unavailable');
  })();

  inflightJson.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inflightJson.delete(cacheKey);
  }
}

const fourkCache = new Map();

function fourkCacheGet(key) {
  const hit = fourkCache.get(key);
  return hit && hit.expires > Date.now() ? hit.value : null;
}

function fourkCacheSet(key, ttl, value) {
  if (ttl <= 0) return;
  fourkCache.set(key, { expires: Date.now() + ttl, value });
  if (fourkCache.size > 400) {
    for (const [k, v] of fourkCache) if (v.expires <= Date.now()) fourkCache.delete(k);
  }
}

function hostMatches(hostname, domain) {
  const host = String(hostname || '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function fourkSourceAllowed(url) {
  return FOURKCZ_HOSTS.some((configured) => {
    try {
      const base = new URL(configured);
      const names = [base.hostname, base.hostname.startsWith('www.') ? base.hostname.slice(4) : `www.${base.hostname}`];
      return url.protocol === base.protocol && names.includes(url.hostname.toLowerCase());
    } catch { return false; }
  });
}

function fourkPlayerAllowed(url) {
  if (fourkSourceAllowed(url)) return true;
  return url.protocol === 'https:' && ['py1080p.com', '4kcz.com', 'czzy.top', 'cz4k.com']
    .some((domain) => hostMatches(url.hostname, domain));
}

function fourkMediaAllowed(url) {
  return url.protocol === 'https:' && ['bytetos.com', 'bytedtos.com', 'py1080p.com']
    .some((domain) => hostMatches(url.hostname, domain));
}

function decodeHtml(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] || '';
    const hex = entity[1].toLowerCase() === 'x';
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

function htmlAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function htmlText(value) {
  return decodeHtml(String(value || '').replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanField(value) {
  return htmlText(value).replace(/\$/g, '＄').replace(/#/g, '＃');
}

function assertFourkHtml(html) {
  if (!/<html[\s>]/i.test(html)) throw upstreamFailure('4K provider returned non-html');
  if (/访问已被拦截|站点已经被管理员停止运行|管理员停止运行|人机验证|验证码/.test(html)) {
    throw upstreamFailure('4K provider unavailable', { blocked: true });
  }
}

async function fourkFetch(baseHost, path, deadline) {
  const target = new URL(path, `${baseHost}/`);
  if (!fourkSourceAllowed(target)) throw new Error('4K source url rejected');
  const queued = Date.now();
  await hostSlot(baseHost);
  const effective = deadline ? deadline + (Date.now() - queued) : undefined;
  const r = await httpGetText(target.toString(), {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Encoding': 'identity', Referer: `${baseHost}/` },
    deadline: effective,
    followRedirects: true,
    redirectAllowed: fourkSourceAllowed,
    tls12: true,
  });
  const html = r.body ? r.body.toString('utf8') : '';
  if (r.error || r.status < 200 || r.status >= 300) throw upstreamFailure('4K source request failed');
  assertFourkHtml(html);
  return html;
}

function parseFourkListing(html, baseHost, options = {}) {
  assertFourkHtml(html);
  const page = options.page || 1;
  const typeId = options.typeId || '1';
  const rows = [];
  const seen = new Set();
  for (const item of String(html).matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)) {
    const block = item[0];
    if (!/\bdytit\b/.test(block)) continue;
    const heading = [...block.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi)]
      .map((match) => match[0])
      .find((tag) => /(?:^|\s)dytit(?:\s|$)/.test(htmlAttr(tag, 'class'))) || '';
    let link = null;
    let id = '';
    let name = '';
    for (const anchor of heading.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      try {
        const href = htmlAttr(anchor[0], 'href');
        const match = new URL(href, `${baseHost}/`).pathname.match(/^\/movie\/(\d{1,8})\.html$/);
        if (!match) continue;
        link = anchor[0];
        id = match[1];
        name = htmlText(anchor[0]);
        break;
      } catch {}
    }
    if (!link || !id || seen.has(id)) continue;
    seen.add(id);
    const image = block.match(/<img\b[^>]*>/i)?.[0] || '';
    const badge = block.match(/<[^>]*class=["'][^"']*\bjidi\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '';
    const actor = block.match(/<[^>]*class=["'][^"']*\binzhuy\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '';
    // 卡片上的分类/清晰度标签，与 4K 站列表展示保持一致。
    const cardLabel = htmlText(block.match(/<span\b[^>]*class=["'][^"']*\b(?:furk|qb)\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const labelType = FOURK_CARD_TYPES[cardLabel] || '';
    let pic = '';
    try {
      const src = htmlAttr(image, 'data-original') || htmlAttr(image, 'src');
      if (src) pic = new URL(src, `${baseHost}/`).toString();
    } catch {}
    rows.push({
      vod_id: `4kcz-${id}`,
      vod_name: name,
      vod_pic: pic,
      vod_remarks: htmlText(badge),
      vod_year: '',
      vod_actor: htmlText(actor).split('：').slice(1).join('：').trim(),
      type_id: labelType ? String(labelType) : typeId,
      type_name: labelType
        ? (FOURK_QUALITY_LABELS.has(cardLabel) ? categoryName(labelType) : cardLabel)
        : categoryName(typeId),
    });
  }
  if (!rows.length && !options.allowEmpty) throw new Error('4K listing structure changed');
  if (!rows.length && options.allowEmpty && !/<main\b|\bmi_cont\b/.test(html)) throw new Error('4K search structure changed');
  const currentPath = (options.path || '/movie_bt').replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
  const pages = [1];
  for (const anchor of String(html).matchAll(/<a\b[^>]*>/gi)) {
    try {
      const pathname = new URL(htmlAttr(anchor[0], 'href'), `${baseHost}/`).pathname;
      const match = pathname.match(new RegExp(`^${currentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/page/(\\d+)/?$`));
      if (match) pages.push(Number(match[1]));
    } catch {}
  }
  const pagecount = Math.max(...pages);
  const pageSize = Math.max(24, rows.length);
  const total = page === pagecount ? (pagecount - 1) * pageSize + rows.length : pagecount * pageSize;
  return { page, pagecount, total, list: rows };
}

function parseFourkDetail(html, baseHost, id) {
  assertFourkHtml(html);
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '';
  const name = htmlText(heading);
  if (!name) throw new Error('4K detail structure changed');
  const info = {};
  for (const item of String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = htmlText(item[1]);
    const idx = text.indexOf('：');
    if (idx > 0) info[text.slice(0, idx).trim()] = text.slice(idx + 1).trim();
  }
  const imageBlock = html.match(/<[^>]*class=["'][^"']*\bdyimg\b[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i)?.[0] || '';
  const image = imageBlock.match(/<img\b[^>]*>/i)?.[0] || '';
  let pic = '';
  try { if (image) pic = new URL(htmlAttr(image, 'src'), `${baseHost}/`).toString(); } catch {}
  let plot = '';
  for (const meta of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const kind = htmlAttr(meta[0], 'property') || htmlAttr(meta[0], 'name');
    if ((kind === 'og:description' || kind === 'description') && htmlAttr(meta[0], 'content')) {
      plot = htmlAttr(meta[0], 'content');
      break;
    }
  }
  const episodes = [];
  for (const anchor of String(html).matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    try {
      const target = new URL(htmlAttr(anchor[0], 'href'), `${baseHost}/`);
      if (!/^\/v_play\/[A-Za-z0-9_=-]+\.html$/.test(target.pathname)) continue;
      episodes.push({ name: cleanField(anchor[0]) || '播放', url: target.toString() });
    } catch {}
  }
  if (!episodes.length) throw new Error('4K detail has no episodes');
  const kind = `${info['类型'] || ''} ${info['分类'] || ''}`;
  const typeId = /综艺/.test(kind) ? '3' : /动漫|番剧/.test(kind) ? '4' : /短剧/.test(kind) ? '5' : /电视剧|国产剧|美剧|韩剧|日剧|欧美剧/.test(kind) || episodes.length > 1 ? '2' : '1';
  return {
    vod_id: id,
    vod_name: name,
    type_id: typeId,
    type_name: categoryName(typeId),
    vod_pic: pic,
    vod_year: info['年份'] || '',
    vod_area: info['地区'] || '',
    vod_lang: info['语言'] || '',
    vod_actor: info['主演'] || '',
    vod_director: info['导演'] || '',
    vod_remarks: episodes[0].name,
    vod_content: plot,
    vod_play_from: '4kcz',
    vod_play_url: episodes.map((ep) => `${ep.name}$${ep.url}`).join('#'),
  };
}

const inflightFourk = new Map();

async function withFourkHosts(key, ttl, operation) {
  const cached = fourkCacheGet(key);
  if (cached) return cached;
  const running = inflightFourk.get(key);
  if (running) return running;

  const task = (async () => {
    let lastError = null;
    for (const baseHost of FOURKCZ_HOSTS) {
      if (hostCooling(baseHost)) continue;
      const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
      try {
        const value = await operation(baseHost, deadline);
        fourkCacheSet(key, ttl, value);
        return value;
      } catch (error) {
        lastError = error;
        if (error && error.hostCool) {
          coolHost(baseHost, error.blocked ? UPSTREAM_BLOCK_COOLDOWN_MS : UPSTREAM_COOLDOWN_MS);
        }
      }
    }
    throw lastError || new Error('all 4K providers unavailable');
  })();

  inflightFourk.set(key, task);
  try {
    return await task;
  } finally {
    inflightFourk.delete(key);
  }
}

async function fetchFourkList({ pg, t }) {
  const page = parsePage(pg);
  // t 已是 4K 支持的一级分类 id（'1'-'5'）；传入对象会导致分类路径查不到而误回退暴风源。
  const cid = String(t || '').trim();
  const paths = cid ? FOURKCZ_CATEGORY_PATHS[cid] : ['/movie_bt'];
  if (!paths) throw new Error('4K category unsupported');
  const pagesNeeded = Math.max(1, Math.ceil(PAGE_SIZE / UPSTREAM_PAGE_SIZE));
  const upstreamStart = (page - 1) * pagesNeeded + 1;
  return withFourkHosts(`list:${cid}:${page}:${PAGE_SIZE}`, TTL.list, async (baseHost, deadline) => {
    const seen = new Set();
    const list = [];
    let totalPagecount = 1;
    let totalAll = 0;
    for (const basePath of paths) {
      for (let i = 0; i < pagesNeeded; i += 1) {
        const upPage = upstreamStart + i;
        const path = upPage > 1 ? `${basePath}/page/${upPage}` : basePath;
        try {
          const html = await fourkFetch(baseHost, path, deadline);
          const parsed = parseFourkListing(html, baseHost, { page: upPage, path, typeId: cid || '1' });
          totalPagecount = Math.max(totalPagecount, parsed.pagecount || 1);
          totalAll += Number(parsed.total) || 0;
          for (const row of (Array.isArray(parsed.list) ? parsed.list : [])) {
            if (seen.has(row.vod_id)) continue;
            seen.add(row.vod_id);
            if (cid) { row.type_id = cid; row.type_name = categoryName(cid); }
            list.push(row);
          }
        } catch (e) {
          console.warn(`[quying] 4K page ${path} failed: ${String(e && e.message || e)}`);
          // One bad upstream page is tolerable; if we collected any rows, keep going.
          // Only re-throw when we have nothing and should try the next mirror.
          if (list.length === 0) throw e;
        }
      }
    }
    return {
      page,
      pagecount: Math.max(1, Math.floor(totalPagecount / pagesNeeded)),
      total: Math.ceil(totalAll / paths.length) * paths.length,
      list: list.slice(0, PAGE_SIZE),
    };
  });
}

async function fetchFourkSearch(wd, pg) {
  const page = parsePage(pg);
  const path = `/search.php?searchword=${encodeURIComponent(wd)}&page=${page}`;
  return withFourkHosts(`search:${wd}:${page}`, TTL.list, async (baseHost, deadline) => {
    const html = await fourkFetch(baseHost, path, deadline);
    return parseFourkListing(html, baseHost, { page, path: '/search.php', allowEmpty: true });
  });
}

async function fetchFourkDetail(id) {
  const match = /^4kcz-(\d{1,8})$/.exec(id);
  if (!match) throw new Error('invalid 4K id');
  return withFourkHosts(`detail:${id}`, TTL.detail, async (baseHost, deadline) => {
    const html = await fourkFetch(baseHost, `/movie/${match[1]}.html`, deadline);
    return parseFourkDetail(html, baseHost, id);
  });
}

function parsePage(value) {
  const n = parseInt(String(value || '1'), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 99999);
}

function parseYear(value) {
  const s = String(value || '').trim();
  return /^\d{4}$/.test(s) ? s : '';
}

function categoryParam(value) {
  const s = String(value || '').trim();
  // Accept our headline ids ('1'-'5') or raw MacCMS type_id numbers.
  if (CATEGORY_BY_ID.has(s)) return { kind: 'headline', value: s, headline: s };
  if (/^\d{1,3}$/.test(s) && TYPE_NAMES[s]) {
    const n = Number(s);
    const headline = HEAD_TO_HEADLINE[n] || CHILD_TO_HEADLINE[n] || '';
    return { kind: 'raw', value: n, headline };
  }
  return null;
}

function categoryName(cid) {
  const c = CATEGORY_BY_ID.get(String(cid));
  if (c) return c.name;
  const n = Number(cid);
  return TYPE_NAMES[n] || '';
}

// bfzy list. For a headline category, child types are merged by page.
// Also accepts a raw MacCMS type_id number to fetch that specific sub-category.
async function fetchBfzyList({ pg, t, year, withPlay }) {
  const page = parsePage(pg);
  const pagesNeeded = Math.max(1, Math.ceil(PAGE_SIZE / UPSTREAM_PAGE_SIZE));
  const upstreamStart = (page - 1) * pagesNeeded + 1;
  const cat = categoryParam(t);

  // Build the list of MacCMS type_ids to query.
  let macTypes = null; // null = no type filter; array of nums = specific types
  if (cat) {
    if (cat.kind === 'headline') {
      macTypes = PROVIDER_TYPES[cat.value].children;
    } else {
      // raw MacCMS type_id — fetch exactly that sub-category
      macTypes = [cat.value];
    }
  }
  // Fetch from bfzy with the resolved type filter.

  const seen = new Set();
  const merged = [];
  let total = 0;
  let upstreamPagecount = 1;

  // Helper to fetch one upstream page for one type filter and merge in.
  async function mergeOnePage(typeNum, upPage) {
    const params = { ac: withPlay ? 'detail' : 'list', pg: upPage };
    if (typeNum != null) params.t = typeNum;
    if (year) params.year = year;
    const data = await upstreamJson(params, TTL.list).catch(() => null);
    if (!data) return;
    total += Number(data.total) || 0;
    upstreamPagecount = Math.max(upstreamPagecount, Number(data.pagecount) || 1);
    for (const item of (Array.isArray(data.list) ? data.list : [])) {
      const key = String(item.vod_id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  if (macTypes && macTypes.length) {
    for (const typeNum of macTypes) {
      for (let i = 0; i < pagesNeeded; i += 1) {
        await mergeOnePage(typeNum, upstreamStart + i);
      }
    }
  } else {
    for (let i = 0; i < pagesNeeded; i += 1) {
      await mergeOnePage(null, upstreamStart + i);
    }
  }

  merged.sort((a, b) => String(b.vod_time || '').localeCompare(String(a.vod_time || '')));
  const list = merged.slice(0, PAGE_SIZE);
  if (!withPlay) await hydrate(list);
  return {
    page,
    pagecount: Math.max(1, Math.floor(upstreamPagecount / pagesNeeded)),
    total,
    list,
  };
}

// Slim list rows omit year/area on this provider; fill them from one batch
// detail call for the visible page.
async function hydrate(list) {
  const ids = list.map((v) => String(v.vod_id || '')).filter(Boolean).slice(0, PAGE_SIZE).join(',');
  if (!ids) return;
  const data = await upstreamJson({ ac: 'detail', ids }, TTL.list).catch(() => null);
  if (!data || !Array.isArray(data.list)) return;
  const byId = new Map(data.list.map((v) => [String(v.vod_id), v]));
  for (let i = 0; i < list.length; i += 1) {
    const full = byId.get(String(list[i].vod_id));
    if (full) list[i] = { ...list[i], ...full };
  }
}

async function hydrateFourk(list) {
  let hydrated = 0;
  const rows = [];
  // One detail page at a time: the 4K mirrors rate-limit bursts.
  for (const row of list) {
    try {
      const full = await fetchFourkDetail(String(row.vod_id));
      hydrated += 1;
      rows.push({ ...row, ...full });
    } catch {
      rows.push(row);
    }
  }
  if (list.length && !hydrated) throw new Error('4K details unavailable');
  return rows;
}

async function fetchListLive({ pg, t, year, withPlay }) {
  const cat = categoryParam(t);
  // Raw MacCMS type_ids (sub-categories like 21=动作片) must go to bfzy,
  // because 4K only supports headline categories and cannot filter by sub-type.
  if (cat && cat.kind === 'raw') return fetchBfzyList({ pg, t, year, withPlay });
  // Determine the headline id for 4K path lookup.
  const headlineId = cat
    ? (cat.kind === 'headline' ? cat.value : cat.headline)
    : '';
  const canUse4k = !year && (!headlineId || FOURKCZ_CATEGORY_PATHS[headlineId]);
  if (canUse4k) {
    try {
      const data = await fetchFourkList({ pg, t: headlineId });
      if (withPlay) data.list = await hydrateFourk(data.list);
      return data;
    } catch {}
  }
  return fetchBfzyList({ pg, t, year, withPlay });
}

async function fetchBfzyDetail(ids) {
  const data = await upstreamJson({ ac: 'detail', ids }, TTL.detail);
  return Array.isArray(data.list) ? data.list : [];
}

async function fetchDetailLive(ids) {
  const idList = String(ids).split(',');
  const bfzyIds = [...new Set(idList.filter((id) => /^\d{1,10}$/.test(id)))];
  const fourkIds = [...new Set(idList.filter((id) => /^4kcz-\d{1,8}$/.test(id)))];
  if (bfzyIds.length + fourkIds.length !== idList.length) throw new Error('invalid vod id');
  const byId = new Map();
  const tasks = [];
  if (bfzyIds.length) {
    tasks.push(fetchBfzyDetail(bfzyIds.join(',')).then((rows) => {
      for (const row of rows) byId.set(String(row.vod_id), row);
    }));
  }
  for (const id of fourkIds) {
    tasks.push(fetchFourkDetail(id).then((row) => byId.set(id, row)));
  }
  await Promise.all(tasks);
  return idList.map((id) => byId.get(id)).filter(Boolean);
}

async function fetchBfzySearch(wd, pg, withPlay) {
  const data = await upstreamJson({ ac: withPlay ? 'detail' : 'list', wd, pg: parsePage(pg) }, TTL.list);
  const list = Array.isArray(data.list) ? data.list : [];
  if (!withPlay) await hydrate(list);
  return {
    page: parsePage(pg),
    pagecount: Number(data.pagecount) || 1,
    total: Number(data.total) || 0,
    list,
  };
}

async function fetchSearchLive(wd, pg, withPlay) {
  try {
    const data = await fetchFourkSearch(wd, pg);
    if (withPlay) data.list = await hydrateFourk(data.list);
    return data;
  } catch {}
  return fetchBfzySearch(wd, pg, withPlay);
}

let catalogWarningShown = false;
function catalogFailed(error) {
  if (catalogWarningShown) return;
  catalogWarningShown = true;
  console.warn(`[quying] catalog store error: ${String((error && error.message) || error)}`);
}

async function readCatalogQuery(key) {
  if (!catalogStore) return null;
  try { return await catalogStore.getQuery(key); } catch (error) { catalogFailed(error); return null; }
}

async function saveCatalogQuery(key, value, ttl) {
  if (!catalogStore) return false;
  try { await catalogStore.saveQuery(key, value, ttl); return true; } catch (error) { catalogFailed(error); return false; }
}

const catalogRefreshQueue = [];
const catalogRefreshing = new Set();
const catalogRefreshRetryAt = new Map();
let catalogRefreshActive = false;

async function drainCatalogRefresh() {
  while (catalogRefreshQueue.length) {
    const task = catalogRefreshQueue.shift();
    try {
      const value = await task.loader();
      catalogRefreshRetryAt.delete(task.key);
      if (!(await saveCatalogQuery(task.key, value, task.ttl))) {
        catalogRefreshRetryAt.set(task.key, Date.now() + UPSTREAM_COOLDOWN_MS);
      }
    } catch {
      // Stale rows stay available; avoid refreshing the same failed key per request.
      catalogRefreshRetryAt.set(task.key, Date.now() + UPSTREAM_COOLDOWN_MS);
    } finally {
      catalogRefreshing.delete(task.key);
    }
  }
  catalogRefreshActive = false;
}

function scheduleCatalogRefresh(key, ttl, loader) {
  if (!catalogStore || catalogRefreshing.has(key)) return;
  if ((catalogRefreshRetryAt.get(key) || 0) > Date.now()) return;
  catalogRefreshing.add(key);
  catalogRefreshQueue.push({ key, ttl, loader });
  if (!catalogRefreshActive) {
    catalogRefreshActive = true;
    setImmediate(drainCatalogRefresh);
  }
}

async function catalogQuery(key, ttl, loader, localLoader) {
  const cached = await readCatalogQuery(key);
  if (cached) {
    if (!cached.stale) return cached.value;
    // Serverless 实例在响应结束后随时会被回收，后台刷新往往来不及落库。
    // 代价是过期后的第一次请求要同步刷新，但能保证采集结果必定写入数据库。
    if (process.env.VERCEL) {
      try {
        const value = await loader();
        await saveCatalogQuery(key, value, ttl);
        return value;
      } catch {
        return cached.value;
      }
    }
    scheduleCatalogRefresh(key, ttl, loader);
    return cached.value;
  }
  if (catalogStore && localLoader) {
    let local = null;
    try { local = await localLoader(); } catch (error) { catalogFailed(error); }
    if (local && Array.isArray(local.list) && local.list.length) {
      if (await saveCatalogQuery(key, local, ttl)) scheduleCatalogRefresh(key, ttl, loader);
      return local;
    }
  }
  const value = await loader();
  await saveCatalogQuery(key, value, ttl);
  return value;
}

function listCacheKey({ pg, t, year, withPlay } = {}) {
  // 查询键必须用字符串，否则原始二级分类会全部落到同一个 [object Object] 缓存上。
  const cat = categoryParam(t);
  const catKey = cat ? `${cat.kind}:${cat.value}` : '';
  return `list:v5:${withPlay ? 1 : 0}:${parsePage(pg)}:${PAGE_SIZE}:${catKey}:${parseYear(year)}`;
}

const RANK_KINDS = new Set(['new', 'hot', 'score']);
const RANK_SOURCE_PAGES = 6;

// 最新/最热/高分推荐：上游不支持排序参数，取前几页本地排序后分页。
// 最新 = 上游默认 vod_time 倒序，直接透传分页；
// 最热 = 按 vod_hits 排序（该字段只在 ac=detail 返回）；高分 = 按 vod_score 排序。
async function fetchRankedList(kind, pg, withPlay, year) {
  const page = parsePage(pg);
  const y = parseYear(year);
  if (kind === 'new' && !y) {
    const data = await fetchBfzyList({ pg: page, t: '', year: '', withPlay });
    return {
      page,
      pagecount: Math.max(1, Number(data.pagecount) || 1),
      total: Number(data.total) || (data.list || []).length,
      list: data.list || [],
    };
  }
  const ac = kind === 'hot' ? 'detail' : 'list';
  const all = [];
  const seen = new Set();
  for (let p = 1; p <= RANK_SOURCE_PAGES; p += 1) {
    const params = { ac, pg: p };
    if (y) params.year = y;
    const data = await upstreamJson(params, TTL.list).catch(() => null);
    if (!data) continue;
    for (const item of (Array.isArray(data.list) ? data.list : [])) {
      const key = String(item.vod_id || '');
      if (!key || seen.has(key)) continue;
      if (y && String(item.vod_year || '') !== y) continue;
      seen.add(key);
      all.push(item);
    }
  }
  const metric = kind === 'hot'
    ? (v) => Number(v.vod_hits) || 0
    : kind === 'score'
      ? (v) => Number(v.vod_score) || 0
      : (v) => String(v.vod_time || '');
  all.sort((a, b) => {
    const av = metric(a);
    const bv = metric(b);
    return typeof av === 'string' ? String(bv).localeCompare(String(av)) : bv - av;
  });
  const start = (page - 1) * PAGE_SIZE;
  const list = all.slice(start, start + PAGE_SIZE);
  if (!withPlay) await hydrate(list);
  return {
    page,
    pagecount: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
    total: all.length,
    list,
  };
}

async function fetchList({ pg, t, year, withPlay }) {
  const cat = categoryParam(t);
  if (cat && cat.kind === 'headline' && RANK_KINDS.has(cat.value)) {
    const key = `rank:${cat.value}:v1:${withPlay ? 1 : 0}:${parsePage(pg)}:${PAGE_SIZE}:${parseYear(year)}`;
    return catalogQuery(key, TTL.list, () => fetchRankedList(cat.value, pg, withPlay, year));
  }
  return catalogQuery(listCacheKey({ pg, t, year, withPlay }), TTL.list, () => fetchListLive({ pg, t, year, withPlay }));
}

async function fetchDetail(ids) {
  const idList = String(ids).split(',').map((s) => s.trim()).filter(Boolean);
  const manualIds = idList.filter((id) => id.startsWith('manual-'));
  const upstreamIds = idList.filter((id) => !id.startsWith('manual-'));
  const rows = [];
  for (const id of manualIds) {
    const vod = await manualVodById(id);
    if (vod) rows.push(vod);
  }
  if (upstreamIds.length) {
    const key = `detail:${upstreamIds.join(',')}`;
    const data = await catalogQuery(key, TTL.detail, async () => {
      const list = await fetchDetailLive(upstreamIds.join(','));
      return { page: 1, pagecount: 1, total: list.length, list };
    });
    rows.push(...data.list);
  }
  return rows;
}

async function fetchSearch(wd, pg, withPlay) {
  const page = parsePage(pg);
  const title = normalizedTitle(wd).toLowerCase();
  const key = `search:${withPlay ? 1 : 0}:${title}:${page}`;
  return catalogQuery(
    key,
    TTL.list,
    () => fetchSearchLive(wd, page, withPlay),
    () => catalogStore.searchVods(title, page, withPlay),
  );
}

// ---- 360kan 首页/栏目推荐：只采集标题，再匹配本站片源；播放仍走现有 4K/暴风源 ----
const KAN_API_BASE = 'https://api.web.360kan.com/v1';
const KAN_SECTIONS = {
  home: { title: '360首页推荐', cat: null, rankCat: null, ourType: '' },
  movie: { title: '电影推荐', cat: '1', rankCat: 2, ourType: '1' },
  tv: { title: '电视剧推荐', cat: '2', rankCat: 3, ourType: '2' },
  variety: { title: '综艺推荐', cat: '3', rankCat: 4, ourType: '3' },
  anime: { title: '动漫推荐', cat: '4', rankCat: 5, ourType: '4' },
};
const KAN_CANDIDATE_LIMIT = 30;
const KAN_TITLE_CACHE = new Map();

async function fetchKanJson(url) {
  const resp = await httpGetText(url, {
    timeout: UPSTREAM_TIMEOUT_MS,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.360kan.com/',
      Accept: 'application/json,text/plain,*/*',
      'Accept-Encoding': 'identity',
    },
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`360kan request failed: ${resp.status}`);
  let json;
  try { json = JSON.parse(resp.body.toString('utf8')); } catch { throw new Error('360kan invalid json'); }
  if (json && json.errno !== 0) throw new Error(`360kan error: ${json.msg || 'unknown'}`);
  return json;
}

async function fetchKanBlock(blockid, size) {
  const url = `${KAN_API_BASE}/block?blockid=${encodeURIComponent(blockid)}&size=${Math.max(1, Number(size) || KAN_CANDIDATE_LIMIT)}`;
  const json = await fetchKanJson(url);
  const list = json && json.data && Array.isArray(json.data.lists) ? json.data.lists : [];
  return list.filter((item) => item && item.title);
}

async function fetchKanRank(cat, size) {
  const url = `${KAN_API_BASE}/rank?cat=${encodeURIComponent(cat)}&size=${Math.max(1, Number(size) || KAN_CANDIDATE_LIMIT)}`;
  const json = await fetchKanJson(url);
  const list = Array.isArray(json && json.data) ? json.data : [];
  return list.filter((item) => item && item.title);
}

async function findLocalExactVod(title) {
  if (!catalogStore) return null;
  try {
    const data = await catalogStore.searchVods(title, 1, false);
    const list = Array.isArray(data && data.list) ? data.list : [];
    const key = titleKey(title);
    return list.find((v) => titleKey(v.vod_name) === key) || null;
  } catch (error) { catalogFailed(error); return null; }
}

async function resolveKanVod(item) {
  const title = normalizedTitle(item && item.title);
  const key = titleKey(title);
  if (!key) return null;
  if (KAN_TITLE_CACHE.has(key)) return KAN_TITLE_CACHE.get(key) || null;
  let row = await findLocalExactVod(title);
  if (!row) {
    try {
      const data = await fetchBfzySearch(title, 1, false);
      const candidates = Array.isArray(data.list) ? data.list : [];
      row = candidates.find((v) => titleKey(v.vod_name) === key) || null;
    } catch {}
  }
  KAN_TITLE_CACHE.set(key, row || null);
  return row;
}

async function collectKanRecommendations(section) {
  const cfg = KAN_SECTIONS[section];
  if (!cfg) throw new Error('unknown kan section');
  const rows = section === 'home'
    ? await fetchKanBlock(522, KAN_CANDIDATE_LIMIT)
    : await fetchKanRank(cfg.rankCat, KAN_CANDIDATE_LIMIT);
  const seeds = rows.filter((item) => !cfg.cat || String(item.cat || '') === cfg.cat);
  const list = [];
  const seen = new Set();
  for (const item of seeds) {
    if (list.length >= 12) break;
    const row = await resolveKanVod(item);
    if (!row) continue;
    const id = String(row.vod_id);
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(row);
  }
  if (!list.length) throw new Error('360kan recommendation unavailable');
  return { page: 1, pagecount: 1, total: list.length, list, source: '360kan' };
}

async function fetchKanRecommendations(section, limit) {
  const max = Math.max(1, Math.min(30, Number(limit) || 12));
  return catalogQuery(
    `kan:v1:${section}:${max}`,
    TTL.list,
    () => collectKanRecommendations(section).then((data) => ({ ...data, list: data.list.slice(0, max) })),
  );
}

// ---- 创意频道：数据库筛选优先，不足时上游采集并自动入库 ----
// 每个频道是一份「候选池快照」：去重排序后整池 saveQuery（所有候选自动 saveVod 入库），
// 分页只从快照切片，避免逐页回源造成重复/漂移。采集统一走暴风 MacCMS（含演员/评分/热度字段）。
const CHANNEL_POOL_LIMIT = 120;
const CHANNELS = [
  { id: 'guess', name: '猜你喜欢', icon: '💡', desc: '越看越懂你：从你最近点开的作品出发，挑出气质相近、值得继续追下去的片单。', kind: 'guess' },
  { id: 'score', name: '高分榜', icon: '🏆', desc: '口碑数字先说话：只收录有明确评分的作品，从高到低慢慢品味。', kind: 'score' },
  { id: 'praise', name: '口碑榜', icon: '👍', desc: '经得起反复打开的作品：筛掉低分噪音，按热度与认可度呈现口碑之选。', kind: 'praise' },
  { id: 'marvel', name: '漫威宇宙', icon: '🦸', desc: '超级英雄集结时刻：钢铁侠、美队、蜘蛛侠……一起重返漫威宇宙的热血与浪漫。', kind: 'series', keywords: ['复仇者联盟', '钢铁侠', '美国队长', '雷神', '蜘蛛侠', '奇异博士', '银河护卫队', '黑豹'] },
  { id: 'harrypotter', name: '哈利·波特', icon: '⚡', desc: '九又四分之三站台已开启：霍格沃茨、魔法部与神奇动物，陪你重返那个有求必应的世界。', kind: 'series', keywords: ['哈利波特', '哈利·波特', '神奇动物在哪里', '神奇动物：'] },
  { id: 'fastfurious', name: '速度与激情', icon: '🏎️', desc: '引擎轰鸣，家族不散：从街头飙车到全球冒险，一次补齐肾上腺素名场面。', kind: 'series', keywords: ['速度与激情'] },
  { id: 'detectivechinatown', name: '唐人街探案', icon: '🕵️', desc: '唐仁与秦风再度合体：搞笑探案、反转谜局，一路笑着追到真相。', kind: 'series', keywords: ['唐人街探案', '唐探'] },
  { id: 'star-cheng-long', name: '成龙频道', icon: '🥋', desc: '动作招牌，笑点也硬：成龙式搏命动作与功夫喜剧，一次看个痛快。', kind: 'star', actor: '成龙' },
  { id: 'star-zhou-xing-chi', name: '周星驰频道', icon: '😂', desc: '无厘头里藏着温柔：周星驰经典银幕时刻，笑过之后还想再刷。', kind: 'star', actor: '周星驰' },
  { id: 'star-wu-jing', name: '吴京频道', icon: '🎖️', desc: '硬汉气质拉满：拳拳到肉的动作场面与家国叙事，热血值直接拉满。', kind: 'star', actor: '吴京' },
  { id: 'star-shen-teng', name: '沈腾频道', icon: '🤣', desc: '笑点长在他身上：沈腾式喜感与名场面，适合随时来一集解压。', kind: 'star', actor: '沈腾' },
  { id: 'guoman', name: '国漫频道', icon: '🐉', desc: '国风想象力正在起飞：热血少年、东方神话与手绘美学，一起见证国漫高光。', kind: 'guoman' },
];
const CHANNEL_BY_ID = new Map(CHANNELS.map((c) => [c.id, c]));

function channelRule(ch) {
  if (ch.kind === 'series') return { kind: 'series', keywords: ch.keywords, limit: CHANNEL_POOL_LIMIT };
  if (ch.kind === 'star') return { kind: 'star', actors: [ch.actor], limit: CHANNEL_POOL_LIMIT };
  return { kind: ch.kind, limit: CHANNEL_POOL_LIMIT };
}

function channelScore(v) { const n = Number(v && v.vod_score); return Number.isFinite(n) ? n : 0; }
function channelHits(v) { const n = Number(v && v.vod_hits); return Number.isFinite(n) ? n : 0; }

function channelItemMatches(ch, v) {
  if (!v) return false;
  if (ch.kind === 'score') return channelScore(v) > 0;
  if (ch.kind === 'praise') return channelScore(v) >= 6;
  if (ch.kind === 'series') {
    const name = normalizedTitle(v.vod_name || '').toLowerCase();
    return (ch.keywords || []).some((k) => {
      const key = normalizedTitle(k).toLowerCase();
      return key && name.includes(key);
    });
  }
  if (ch.kind === 'star') return String(v.vod_actor || '').includes(ch.actor);
  if (ch.kind === 'guoman') {
    const type = String(v.type_id || '');
    const area = String(v.vod_area || '');
    return type === '40' || (['4', '41', '42', '43'].includes(type) && area.includes('大陆'));
  }
  return true;
}

function sortChannelPool(ch, all) {
  // 最终兜底校验：采集和库筛合并后，仍按频道主题规则过滤一次，避免出现随机/无关内容。
  const list = all.filter((v) => channelItemMatches(ch, v));
  const metric = ch.kind === 'praise' ? channelHits : channelScore;
  return list
    .sort((a, b) => metric(b) - metric(a) || String(a.vod_id).localeCompare(String(b.vod_id)))
    .slice(0, CHANNEL_POOL_LIMIT);
}

async function collectChannelPool(ch) {
  const seen = new Set();
  const all = [];
  const push = (items) => {
    for (const item of items || []) {
      const id = String(item && item.vod_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(item);
    }
  };
  if (ch.kind === 'score' || ch.kind === 'praise') {
    const ac = ch.kind === 'praise' ? 'detail' : 'list';
    for (let p = 1; p <= RANK_SOURCE_PAGES; p += 1) {
      const data = await upstreamJson({ ac, pg: p }, TTL.list).catch(() => null);
      if (data) push(data.list);
    }
  } else if (ch.kind === 'guoman') {
    for (let p = 1; p <= 3; p += 1) {
      const data = await upstreamJson({ ac: 'detail', t: 40, pg: p }, TTL.list).catch(() => null);
      if (data) push(data.list);
    }
  } else if (ch.kind === 'series') {
    const keys = ch.keywords.slice(0, 8).map((k) => normalizedTitle(k).toLowerCase());
    for (const kw of ch.keywords.slice(0, 8)) {
      const data = await fetchBfzySearch(kw, 1, true).catch(() => null);
      // 上游搜索是模糊匹配，必须再按关键词过滤片名，与库内筛选口径一致。
      if (data) push((data.list || []).filter((v) => {
        const name = normalizedTitle(v.vod_name || '').toLowerCase();
        return keys.some((k) => k && name.includes(k));
      }));
    }
  } else if (ch.kind === 'star') {
    // wd 搜索仅用于缩小候选，必须再按演员字段严格过滤，标题命中不算数。
    for (let p = 1; p <= 2; p += 1) {
      const data = await fetchBfzySearch(ch.actor, p, true).catch(() => null);
      if (data) push((data.list || []).filter((v) => String(v.vod_actor || '').includes(ch.actor)));
    }
  }
  const list = sortChannelPool(ch, all);
  if (!list.length) throw new Error('频道片源暂不可用');
  return { page: 1, pagecount: 1, total: list.length, list };
}

async function fetchChannelPool(ch) {
  const key = `channel:${ch.id}:v1:${CHANNEL_POOL_LIMIT}`;
  return catalogQuery(
    key,
    TTL.list,
    async () => {
      const fresh = await collectChannelPool(ch);
      // 与库内已有候选合并：上游部分页失败导致采集变少时，快照不会因此缩水。
      if (catalogStore) {
        try {
          const local = await catalogStore.channelVods(channelRule(ch));
          const seen = new Set(fresh.list.map((v) => String(v.vod_id)));
          const merged = [...fresh.list];
          for (const v of local.list || []) {
            if (!seen.has(String(v.vod_id))) { seen.add(String(v.vod_id)); merged.push(v); }
          }
          const list = sortChannelPool(ch, merged);
          return { page: 1, pagecount: 1, total: list.length, list };
        } catch (error) { catalogFailed(error); }
      }
      return fresh;
    },
    catalogStore ? () => catalogStore.channelVods(channelRule(ch)) : undefined,
  );
}

function sliceChannelPool(pool, pg) {
  const page = parsePage(pg);
  const total = Number(pool.total) || (pool.list || []).length;
  const pagecount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  return { page, pagecount, total, list: (pool.list || []).slice(start, start + PAGE_SIZE) };
}

// 猜你喜欢：种子仅取库内已有详情派生演员/类型，不写共享缓存，无有效种子时回退口碑榜。
async function fetchGuessPool(seeds, exclude) {
  if (!catalogStore || !seeds.length) return null;
  let info = [];
  try { info = await catalogStore.seedsInfo(seeds); } catch (error) { catalogFailed(error); return null; }
  if (!info.length) return null;
  const actors = [...new Set(info
    .flatMap((r) => String(r.actor || '').split(/[,，/、]/).map((s) => s.trim()))
    .filter((s) => s && s.length <= 12 && !/^\d+$/.test(s)))].slice(0, 6);
  const typeIds = [...new Set(info.map((r) => String(r.type_id || '')).filter(Boolean))].slice(0, 8);
  if (!actors.length && !typeIds.length) return null;
  const pool = await catalogStore.channelVods({ kind: 'guess', actors, typeIds, exclude, limit: CHANNEL_POOL_LIMIT });
  return pool.list.length ? pool : null;
}

// Fetch a single detail record for playback resolution without crossing ID schemes.
async function detailForPlay(id) {
  const row = /^4kcz-\d{1,8}$/.test(id)
    ? await fetchFourkDetail(id)
    : (await fetchBfzyDetail(id)).find((item) => String(item.vod_id) === String(id)) || null;
  // 采集到的详情同样回写数据库，供后续 ac=detail 直接命中。
  if (row) await saveCatalogQuery(`detail:${id}`, { page: 1, pagecount: 1, total: 1, list: [row] }, TTL.detail);
  return row;
}

function normalizedTitle(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function titleKey(value) {
  return normalizedTitle(value)
    .toLowerCase()
    .replace(/[\s:：·,，.。!！?？'’"“”()（）\-_/\\|【】\[\]{}]+/g, '');
}

function normalizedEpisode(value) {
  return normalizedTitle(value).toLowerCase();
}

function episodeNumber(value) {
  const text = normalizedTitle(value);
  const match = text.match(/第\s*0*(\d+)\s*集/i) || text.match(/\bE?P\s*0*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

async function bfzyTitleCandidates(row) {
  const title = normalizedTitle(row && row.vod_name);
  if (!title) return [];
  const data = await upstreamJson({ ac: 'detail', wd: title }, 0);
  const seen = new Set();
  const titled = (Array.isArray(data.list) ? data.list : []).filter((candidate) => {
    const id = String(candidate.vod_id || '');
    if (!/^\d{1,10}$/.test(id) || seen.has(id) || normalizedTitle(candidate.vod_name) !== title) return false;
    seen.add(id);
    return true;
  });
  const sourceYear = String(row.vod_year || '').trim();
  if (!sourceYear) return titled.length === 1 ? titled : [];
  return titled.filter((candidate) => {
    const year = String(candidate.vod_year || '').trim();
    return year ? year === sourceYear : titled.length === 1;
  });
}

function mapBfzyEpisode(sourceRow, sourceEpisodes, sourceEp, sourceSeq, candidate) {
  const episodes = playableGroups(candidate.vod_play_url).flat();
  if (!episodes.length) return null;
  const bothMovies = mapTypeId(sourceRow.type_id) === '1' && mapTypeId(candidate.type_id) === '1';
  if (bothMovies && (sourceEpisodes.length !== 1 || episodes.length !== 1 || sourceSeq !== 0)) return null;
  let matches = episodes.filter((ep) => normalizedEpisode(ep.name) === normalizedEpisode(sourceEp.name));
  if (!matches.length) {
    const number = episodeNumber(sourceEp.name);
    if (number !== null) matches = episodes.filter((ep) => episodeNumber(ep.name) === number);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function resolveBfzyFallback(row, sourceEpisodes, sourceEp, sourceSeq) {
  const candidates = await bfzyTitleCandidates(row);
  const matches = [];
  for (const candidate of candidates) {
    const ep = mapBfzyEpisode(row, sourceEpisodes, sourceEp, sourceSeq, candidate);
    if (ep) matches.push(ep);
  }
  if (matches.length !== 1) throw new Error('no unambiguous bfzy fallback');
  return new URL(matches[0].url);
}

async function resolveFourkMedia(ep) {
  let episodePath;
  try { episodePath = new URL(ep.url).pathname; } catch { throw new Error('bad 4K episode url'); }
  if (!/^\/v_play\/[A-Za-z0-9_=-]+\.html$/.test(episodePath)) throw new Error('bad 4K episode path');
  return withFourkHosts(`play:${episodePath}`, 0, async (baseHost, deadline) => {
    const html = await fourkFetch(baseHost, episodePath, deadline);
    const iframe = [...String(html).matchAll(/<iframe\b[^>]*>/gi)]
      .map((match) => match[0])
      .find((tag) => /(?:^|\s)viframe(?:\s|$)/.test(htmlAttr(tag, 'class')) && htmlAttr(tag, 'src'));
    if (!iframe) throw new Error('4K player unavailable');
    const player = new URL(htmlAttr(iframe, 'src'), `${baseHost}/`);
    if (!fourkPlayerAllowed(player)) throw new Error('4K player rejected');
    const response = await httpGetText(player.toString(), {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Encoding': 'identity', Referer: `${baseHost}/` },
      deadline,
      followRedirects: true,
      redirectAllowed: fourkPlayerAllowed,
    });
    const playerHtml = response.body ? response.body.toString('utf8') : '';
    if (response.error || response.status < 200 || response.status >= 300) throw new Error('4K player request failed');
    const match = playerHtml.match(/\b(?:const|let|var)\s+mysvg\s*=\s*(['"])(https?:\/\/.*?)\1\s*;/)
      || playerHtml.match(/\bart\.url\s*=\s*(['"])(https?:\/\/.*?)\1\s*;/);
    if (!match) throw new Error('4K media unavailable');
    const media = new URL(match[2]);
    if (!fourkMediaAllowed(media)) throw new Error('4K media rejected');
    return media;
  });
}

async function resolvePlayback(id, seq) {
  const row = await detailForPlay(id);
  const isFourk = id.startsWith('4kcz-');
  const episodes = row ? playableGroups(row.vod_play_url, isFourk).flat() : [];
  const ep = episodes[seq];
  if (!ep) {
    const error = new Error('episode not found');
    error.status = 404;
    throw error;
  }
  if (!isFourk) return { media: new URL(ep.url), name: ep.name };
  try {
    return { media: await resolveFourkMedia(ep), name: ep.name };
  } catch {}
  return { media: await resolveBfzyFallback(row, episodes, ep, seq), name: ep.name };
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const ext = path.extname(filePath).toLowerCase();
    const noCache = ['.html', '.js', '.mjs', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

async function fetchImage(target) {
  return httpGetText(target, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*', 'Accept-Encoding': 'identity' },
  });
}

const M3U8_AD_RULES = [
  { hostname: 'v.fengbao14.com', segmentPath: '/video/adjump/' },
];

function m3u8AdRule(url) {
  const hostname = url.hostname.toLowerCase();
  return M3U8_AD_RULES.find((rule) => rule.hostname === hostname) || null;
}

function absolutePlaylistUri(uri, base) {
  try { return new URL(uri, base).toString(); } catch { return uri; }
}

// Remove only provider-tagged ad blocks. Segment URIs must become absolute
// because the filtered playlist is served from our own origin.
function filterM3u8(body, media, rule) {
  const output = [];
  let pending = [];
  let removedAd = false;
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const resolved = new URL(trimmed, media);
      if (resolved.hostname.toLowerCase() === rule.hostname && resolved.pathname.startsWith(rule.segmentPath)) {
        pending = [];
        removedAd = true;
        continue;
      }
      if (removedAd) pending = pending.filter((line) => line.trim() !== '#EXT-X-DISCONTINUITY');
      output.push(...pending, resolved.toString());
      pending = [];
      removedAd = false;
      continue;
    }
    pending.push(raw.replace(/URI="([^"]*)"/g, (_match, uri) => `URI="${absolutePlaylistUri(uri, media)}"`));
  }
  output.push(...pending);
  return output.join('\n');
}

// ---- MacCMS-compatible payloads ----
function listPayload(data, base, withPlay) {
  return {
    code: 1,
    msg: '数据列表',
    page: data.page,
    pagecount: data.pagecount,
    limit: PAGE_SIZE,
    total: data.total,
    list: data.list.map((v) => normalizeItem(v, base, withPlay)).filter(Boolean),
    class: CLASSES,
  };
}

// ---- 屏蔽词与手动影片（进程内缓存 30 秒，后台修改后立即失效） ----
let insightCache = { at: 0, words: [], manual: [] };

function resetInsights() { insightCache = { at: 0, words: [], manual: [] }; }

async function insights() {
  if (!adminStore) return { words: [], manual: [] };
  if (Date.now() - insightCache.at < 30000) return insightCache;
  try {
    const settings = await adminStore.getSettings();
    const words = String(settings.blocked_words || '')
      .split(/[\n,，]/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 500);
    const manual = await adminStore.listManualVods();
    insightCache = { at: Date.now(), words, manual };
  } catch (error) {
    console.warn('[quying] insight load failed:', error.message);
  }
  return insightCache;
}

function blockedName(name, words) {
  if (!words || !words.length) return false;
  const key = normalizedTitle(name).toLowerCase();
  return words.some((w) => key.includes(w));
}

function manualMatchType(vod, t) {
  const cat = categoryParam(t);
  if (!cat) return true;
  const tid = Number(vod.type_id);
  if (cat.kind === 'headline') return (PROVIDER_TYPES[cat.value]?.children || []).includes(tid);
  return tid === Number(cat.value);
}

function manualEpisodes(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const cut = line.indexOf('|');
    const name = cut > 0 ? line.slice(0, cut).trim() : `第${index + 1}集`;
    const url = (cut > 0 ? line.slice(cut + 1) : line).trim();
    return `${name}$${url}`;
  }).join('#');
}

async function manualVodById(id) {
  const { manual } = await insights();
  return manual.find((v) => String(v.vod_id) === String(id)) || null;
}

// 列表/搜索统一出口：过滤屏蔽词，并在第一页混入手动影片。
async function publicListPayload(data, base, withPlay, opts = {}) {
  const { words, manual } = await insights();
  const page = Number(data.page) || 1;
  let list = data.list.filter((v) => !blockedName(v.vod_name, words));
  if (page === 1 && manual.length && opts.manual !== false) {
    const wdKey = opts.wd ? normalizedTitle(opts.wd).toLowerCase() : '';
    const extra = manual
      .filter((v) => !blockedName(v.vod_name, words))
      .filter((v) => !wdKey || normalizedTitle(v.vod_name).toLowerCase().includes(wdKey))
      .filter((v) => opts.wd || manualMatchType(v, opts.t))
      .filter((v) => !opts.year || String(v.vod_year || '') === String(opts.year));
    const seen = new Set(list.map((v) => String(v.vod_id)));
    list = [...extra.filter((v) => !seen.has(String(v.vod_id))), ...list];
  }
  return {
    code: 1,
    msg: '数据列表',
    page,
    pagecount: data.pagecount,
    limit: PAGE_SIZE,
    total: Math.max(Number(data.total) || 0, list.length),
    list: list.map((v) => normalizeItem(v, base, withPlay)).filter(Boolean),
    class: CLASSES,
  };
}

async function publicDetailPayload(rows, base, withPlay) {
  const { words } = await insights();
  const enriched = withPlay
    ? await Promise.all(rows.map((row, index) => (index < 3 ? withPlaySources(row, base).catch(() => row) : row)))
    : rows;
  const list = enriched.filter((v) => !blockedName(v.vod_name, words));
  return {
    code: 1,
    msg: '数据列表',
    page: 1,
    pagecount: 1,
    limit: PAGE_SIZE,
    total: list.length,
    list: list.map((v) => normalizeItem(v, base, withPlay)).filter(Boolean),
    class: CLASSES,
  };
}

// ---- 手动影片与采集任务 ----
const COLLECT_CATS = ['', '1', '2', '3', '4', '5', '6', '7'];
const COLLECT_MAX_PAGES = 6;

function manualError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeManualVod(input = {}) {
  const name = String(input.vod_name || '').trim().slice(0, 120);
  if (!name) throw manualError('影片名称必填');
  const typeId = Number(input.type_id);
  if (!Number.isInteger(typeId) || !TYPE_NAMES[typeId]) throw manualError('分类无效');
  const pic = String(input.vod_pic || '').trim().slice(0, 800);
  if (pic && !/^https?:\/\//i.test(pic)) throw manualError('海报必须是 http/https 地址');
  const playUrl = manualEpisodes(input.vod_play_url);
  if (!playUrl) throw manualError('至少填写一集播放地址');
  const urls = playUrl.split('#').map((ep) => ep.split('$')[1] || '');
  if (urls.some((u) => !/^https?:\/\//i.test(u))) throw manualError('播放地址必须是 http/https 链接');
  const id = /^manual-[a-z0-9]{4,24}$/.test(String(input.vod_id || ''))
    ? String(input.vod_id)
    : `manual-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  return {
    vod_id: id,
    vod_name: name,
    type_id: String(typeId),
    type_name: TYPE_NAMES[typeId] || '',
    vod_year: String(input.vod_year || '').trim().slice(0, 10),
    vod_area: String(input.vod_area || '').trim().slice(0, 30),
    vod_remarks: String(input.vod_remarks || '').trim().slice(0, 60),
    vod_actor: String(input.vod_actor || '').trim().slice(0, 200),
    vod_director: String(input.vod_director || '').trim().slice(0, 120),
    vod_content: String(input.vod_content || '').trim().slice(0, 2000),
    vod_pic: pic,
    vod_play_from: '手动线路',
    vod_play_url: playUrl,
    manual: true,
    updated_at: Date.now(),
  };
}

function parseCollectCursor(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    const ci = Number(parsed.ci);
    const page = Number(parsed.page);
    if (Number.isInteger(ci) && ci >= 0 && ci < COLLECT_CATS.length && Number.isInteger(page) && page >= 1) {
      return { ci, page };
    }
  } catch { /* 使用默认游标 */ }
  return { ci: 0, page: 1 };
}

// 分批采集：每次最多处理若干页，避免撞上 Serverless 执行时长上限。
async function collectBatch({ pages = 3, force = false } = {}) {
  const settings = await adminStore.getSettings();
  let cursor = parseCollectCursor(settings.collect_cursor);
  const limit = Math.min(Math.max(Number(pages) || 3, 1), COLLECT_MAX_PAGES);
  const started = Date.now();
  let processed = 0;
  let skipped = 0;
  let cycleDone = false;
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && Date.now() - started > 45000) break;
    const t = COLLECT_CATS[cursor.ci];
    const key = listCacheKey({ pg: cursor.page, t, year: '' });
    const cached = await catalogStore.getQuery(key);
    let pagecount = cached && cached.value ? Number(cached.value.pagecount) || 1 : 1;
    if (cached && !cached.stale && !force) {
      skipped += 1;
    } else {
      const data = await fetchList({ pg: cursor.page, t, year: '' });
      pagecount = Number(data.pagecount) || 1;
      processed += 1;
    }
    if (cursor.page >= pagecount) {
      cursor = { ci: (cursor.ci + 1) % COLLECT_CATS.length, page: 1 };
      if (cursor.ci === 0) cycleDone = true;
    } else {
      cursor = { ci: cursor.ci, page: cursor.page + 1 };
    }
  }
  const total = (Number(settings.collect_total) || 0) + processed;
  await adminStore.updateSettings({
    collect_cursor: JSON.stringify(cursor),
    collect_last_run: String(Date.now()),
    collect_total: String(total),
  });
  return { processed, skipped, cursor, cycleDone, total };
}

function tvboxConfig(base) {
  return {
    name: '趣影',
    sites: [{
      key: 'quying',
      name: '趣影',
      type: 1,
      api: `${base}/api.php/provide/vod`,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    }],
    lives: [],
    parses: [],
    flags: [],
  };
}

// ---- 后台：公开站点配置、广告与鉴权 ----
async function sitePayload() {
  const settings = adminStore ? await adminStore.getSettings() : {};
  return {
    ok: true,
    name: settings.site_name || '趣影',
    subtitle: settings.site_subtitle || '高清影视 · 即搜即看',
    notice: settings.site_notice || '',
    footer: settings.footer_text || '',
    adsEnabled: (settings.ads_enabled == null ? '1' : String(settings.ads_enabled)) !== '0',
    carouselInterval: Math.max(2000, Math.min(15000, Number(settings.carousel_interval) || 5000)),
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function adminToken(req) {
  const token = parseCookies(req).qy_admin;
  return adminStore && await adminStore.validateSession(token) ? token : '';
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  // 浏览器同源请求（含 fetch 的 PUT/POST）一定带 Origin，缺失即视为不可信
  if (!origin) return false;
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

async function handleAdmin(req, res, p, url) {
  if (!adminStore) {
    sendJson(res, 503, { ok: false, error: '后台未启用：数据库不可用' });
    return;
  }
  const method = req.method;

  if (p === '/api/admin/login' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); return; }
    if (!await adminStore.verifyPassword(body.password || '')) {
      sendJson(res, 401, { ok: false, error: '密码错误' });
      return;
    }
    const token = await adminStore.createSession();
    res.setHeader('Set-Cookie', `qy_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === '/api/admin/session' && method === 'GET') {
    sendJson(res, 200, { ok: true, authed: !!(await adminToken(req)) });
    return;
  }

  // 采集接口：允许后台会话，或用采集密钥（供 GitHub Actions 定时调用）
  if (p === '/api/admin/collect' && (method === 'POST' || method === 'GET')) {
    let body = {};
    if (method === 'POST') {
      try { body = await readJsonBody(req); } catch { body = {}; }
    }
    if (!await adminToken(req)) {
      const settings = await adminStore.getSettings();
      const expected = String(settings.collect_token || '');
      const given = String(body.token || url.searchParams.get('token') || '');
      if (!expected || given !== expected) {
        sendJson(res, 401, { ok: false, error: '采集密钥无效' });
        return;
      }
    }
    const result = await collectBatch({
      pages: body.pages || url.searchParams.get('pages'),
      force: body.force === true || url.searchParams.get('force') === '1',
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  const token = await adminToken(req);
  if (!token) {
    sendJson(res, 401, { ok: false, error: '请先登录' });
    return;
  }
  if (method !== 'GET' && !sameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
    return;
  }

  try {
    if (p === '/api/admin/logout' && method === 'POST') {
      await adminStore.destroySession(token);
      res.setHeader('Set-Cookie', 'qy_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/admin/overview' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: await adminStore.overview() });
      return;
    }

    if (p === '/api/admin/settings' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: await adminStore.getSettings() });
      return;
    }
    if (p === '/api/admin/categories' && method === 'GET') {
      sendJson(res, 200, { ok: true, list: CLASSES });
      return;
    }
    if (p === '/api/admin/settings' && method === 'PUT') {
      const body = await readJsonBody(req);
      const data = await adminStore.updateSettings(body);
      resetInsights();
      sendJson(res, 200, { ok: true, data });
      return;
    }

    // ---- 手动影片 ----
    if (p === '/api/admin/videos' && method === 'GET') {
      sendJson(res, 200, { ok: true, list: await adminStore.listManualVods() });
      return;
    }
    if (p === '/api/admin/videos' && method === 'POST') {
      const body = await readJsonBody(req);
      const vod = normalizeManualVod(body);
      await adminStore.saveManualVod(vod);
      resetInsights();
      sendJson(res, 200, { ok: true, data: vod });
      return;
    }
    const videoMatch = p.match(/^\/api\/admin\/videos\/(manual-[a-z0-9]{4,24})$/);
    if (videoMatch && method === 'DELETE') {
      await adminStore.deleteManualVod(videoMatch[1]);
      resetInsights();
      sendJson(res, 200, { ok: true, deleted: true });
      return;
    }

    // ---- 采集状态与密钥 ----
    if (p === '/api/admin/collect/status' && method === 'GET') {
      const settings = await adminStore.getSettings();
      sendJson(res, 200, {
        ok: true,
        data: {
          cursor: parseCollectCursor(settings.collect_cursor),
          token: String(settings.collect_token || ''),
          total: Number(settings.collect_total) || 0,
          lastRun: Number(settings.collect_last_run) || 0,
          categories: COLLECT_CATS.length,
        },
      });
      return;
    }
    if (p === '/api/admin/collect/token' && method === 'POST') {
      const tokenValue = crypto.randomBytes(16).toString('hex');
      await adminStore.updateSettings({ collect_token: tokenValue });
      sendJson(res, 200, { ok: true, token: tokenValue });
      return;
    }

    if (p === '/api/admin/password' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!await adminStore.verifyPassword(body.oldPassword || '')) {
        sendJson(res, 400, { ok: false, error: '原密码错误' });
        return;
      }
      const next = String(body.newPassword || '');
      if (next.length < 6) { sendJson(res, 400, { ok: false, error: '新密码至少 6 位' }); return; }
      await adminStore.setPassword(next);
      await adminStore.destroySession(token);
      res.setHeader('Set-Cookie', 'qy_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      sendJson(res, 200, { ok: true, relogin: true });
      return;
    }

    if (p === '/api/admin/ads' && method === 'GET') {
      sendJson(res, 200, { ok: true, list: await adminStore.listAds(url.searchParams.get('slot')) });
      return;
    }
    if (p === '/api/admin/ads' && method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, data: await adminStore.createAd(body) });
      return;
    }
    const adMatch = p.match(/^\/api\/admin\/ads\/(\d+)$/);
    if (adMatch && method === 'PUT') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, data: await adminStore.updateAd(adMatch[1], body) });
      return;
    }
    if (adMatch && method === 'DELETE') {
      sendJson(res, 200, { ok: true, deleted: await adminStore.deleteAd(adMatch[1]) });
      return;
    }

    if (p === '/api/admin/cards' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        data: await adminStore.listCards({
          status: url.searchParams.get('status') || '',
          q: url.searchParams.get('q') || '',
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
        }),
      });
      return;
    }
    if (p === '/api/admin/cards/generate' && method === 'POST') {
      const body = await readJsonBody(req);
      const codes = await adminStore.generateCards(body);
      sendJson(res, 200, { ok: true, codes });
      return;
    }
    if (p === '/api/admin/cards/export' && method === 'GET') {
      const rows = ['卡密,天数,状态,备注,创建时间,使用时间'];
      for (const card of await adminStore.exportCards()) {
        rows.push([
          card.code, card.days, card.status, card.note,
          card.createdAt ? new Date(card.createdAt).toISOString() : '',
          card.usedAt ? new Date(card.usedAt).toISOString() : '',
        ].map(csvCell).join(','));
      }
      const body = '\uFEFF' + rows.join('\r\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="card-keys.csv"',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    const cardMatch = p.match(/^\/api\/admin\/cards\/(\d+)$/);
    if (cardMatch && method === 'PATCH') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, updated: await adminStore.setCardStatus(cardMatch[1], body.status) });
      return;
    }
    if (cardMatch && method === 'DELETE') {
      sendJson(res, 200, { ok: true, deleted: await adminStore.deleteCard(cardMatch[1]) });
      return;
    }

    sendJson(res, 404, { ok: false, error: '后台接口不存在' });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
  }
}

// 请求处理器：既供本地 http.createServer 使用，也作为 Vercel Serverless 函数入口导出
export async function requestHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad request' });
    return;
  }
  const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const base = publicBase(req);

  // 后台接口：自身处理登录态与请求方法
  if (p === '/api/admin' || p.startsWith('/api/admin/')) {
    await handleAdmin(req, res, p, url);
    return;
  }

  if (req.method !== 'GET' && !(req.method === 'POST' && p === '/api/vod/channel')) {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  if (p === '/api/health') {
    sendJson(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  // 前台公开配置与广告位
  if (p === '/api/site') {
    sendJson(res, 200, await sitePayload());
    return;
  }
  if (p === '/api/ads') {
    const slot = url.searchParams.get('slot') === 'nav' ? 'nav' : 'carousel';
    sendJson(res, 200, { ok: true, list: adminStore ? await adminStore.publicAds(slot) : [] });
    return;
  }
  if (p === '/api/card/verify') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) { sendJson(res, 400, { ok: false, error: 'code is required' }); return; }
    sendJson(res, 200, { ok: true, ...(adminStore ? await adminStore.verifyCard(code) : { valid: false, reason: '后台未启用' }) });
    return;
  }

  // 后台页面
  if (p === '/admin' || p === '/admin/') {
    serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    return;
  }

  // Poster proxy: only known poster CDN hosts are fetched server-side.
  if (p === '/img') {
    const raw = url.searchParams.get('url') || '';
    let parsed;
    try { parsed = new URL(raw); } catch { sendJson(res, 400, { ok: false, error: 'bad url' }); return; }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !imageHostAllowed(parsed.hostname)) {
      sendJson(res, 403, { ok: false, error: 'host not allowed' });
      return;
    }
    const r = await fetchImage(parsed.toString());
    const ct = (r.headers && r.headers['content-type']) || '';
    if (r.error || r.status < 200 || r.status >= 300 || !ct.startsWith('image/')) {
      sendJson(res, 404, { ok: false, error: 'image unavailable' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': r.body.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(r.body);
    return;
  }

  if (p === '/api/vod/tvbox') {
    sendJson(res, 200, tvboxConfig(base));
    return;
  }

  // ---- Playback: resolve 4K in real time, then fall back to an exact bfzy match ----
  if (p === '/play.m3u8' || p === '/resolve') {
    const id = String(url.searchParams.get('id') || '').trim();
    const seq = String(url.searchParams.get('p') || '0').trim();
    if (!/^(?:\d{1,10}|4kcz-\d{1,8})$/.test(id) || !/^\d{1,5}$/.test(seq)) {
      sendJson(res, 400, { ok: false, error: 'id/p required' });
      return;
    }
    const fail = (status, error) => {
      const browserNavigation = p === '/play.m3u8' && /text\/html/i.test(String(req.headers.accept || ''));
      if (status >= 500 && browserNavigation) {
        res.writeHead(302, { Location: '/?error=playback', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(res, status, { ok: false, error: String((error && error.message) || error) });
    };
    let resolved;
    try {
      resolved = await resolvePlayback(id, Number(seq));
      if (resolved.media.protocol !== 'https:' && resolved.media.protocol !== 'http:') throw new Error('bad media protocol');
    } catch (error) {
      fail(error.status || 502, error);
      return;
    }
    const { media, name } = resolved;
    const adRule = m3u8AdRule(media);
    if (p === '/play.m3u8' && adRule) {
      const r = await httpGetText(media.toString(), {
        headers: { 'User-Agent': UA, Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*', 'Accept-Encoding': 'identity' },
        timeout: UPSTREAM_TIMEOUT_MS,
      });
      const body = r.body ? r.body.toString('utf8') : '';
      if (r.error || r.status < 200 || r.status >= 300 || !body.trimStart().startsWith('#EXTM3U')) {
        fail(502, 'media playlist unavailable');
        return;
      }
      let filtered;
      try { filtered = filterM3u8(body, media, adRule); } catch (error) { fail(502, error); return; }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Length': Buffer.byteLength(filtered),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(filtered);
      return;
    }
    if (p === '/resolve') {
      sendJson(res, 200, { code: 1, msg: 'ok', url: media.toString(), name });
      return;
    }
    res.writeHead(302, {
      Location: media.toString(),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end();
    return;
  }

  // ---- Frontend JSON API ----
  if (p === '/api/vod/kan') {
    const section = String(url.searchParams.get('section') || '');
    const cfg = KAN_SECTIONS[section];
    if (!cfg) { sendJson(res, 400, { ok: false, error: 'unknown kan section' }); return; }
    try {
      const limit = Math.max(1, Math.min(30, Number(url.searchParams.get('limit')) || 12));
      const data = await fetchKanRecommendations(section, limit);
      const payload = await publicListPayload(data, publicBase(req), false, { manual: false, t: cfg.ourType || undefined });
      payload.source = '360kan';
      payload.section = section;
      sendJson(res, 200, payload);
      return;
    } catch {
      try {
        const fallback = await fetchListLive({ pg: 1, t: cfg.ourType || '', year: '', withPlay: false });
        const payload = await publicListPayload(
          { ...fallback, list: (fallback.list || []).slice(0, 12) },
          publicBase(req),
          false,
          { manual: false, t: cfg.ourType || undefined },
        );
        payload.source = 'fallback';
        payload.section = section;
        sendJson(res, 200, payload);
        return;
      } catch (error) {
        sendJson(res, 502, { ok: false, error: (error && error.message) || 'recommendation unavailable' });
        return;
      }
    }
  }

  if (p === '/api/vod/channels') {
    sendJson(res, 200, {
      code: 1,
      list: CHANNELS.map(({ id, name, icon, desc, kind }) => ({ id, name, icon, desc, kind })),
    });
    return;
  }

  if (p === '/api/vod/channel') {
    const ch = CHANNEL_BY_ID.get(String(url.searchParams.get('id') || ''));
    if (!ch) { sendJson(res, 400, { ok: false, error: 'unknown channel id' }); return; }
    try {
      if (ch.kind === 'guess') {
        let body = {};
        if (req.method === 'POST') { try { body = await readJsonBody(req); } catch { body = {}; } }
        const idRe = /^(?:\d{1,10}|4kcz-\d{1,8})$/;
        const seeds = (Array.isArray(body.seeds) ? body.seeds : []).filter((s) => typeof s === 'string' && idRe.test(s)).slice(0, 5);
        const exclude = (Array.isArray(body.exclude) ? body.exclude : []).filter((s) => typeof s === 'string' && idRe.test(s)).slice(0, 20);
        const personalized = seeds.length ? await fetchGuessPool(seeds, exclude) : null;
        const pool = personalized || await fetchChannelPool(CHANNEL_BY_ID.get('praise'));
        const payload = await publicListPayload(sliceChannelPool(pool, url.searchParams.get('pg')), base, false, { manual: false });
        payload.channel = { id: ch.id, name: ch.name, icon: ch.icon, desc: ch.desc, personalized: Boolean(personalized) };
        // 浏览历史属于个人隐私：不写共享缓存，响应禁止缓存。
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, payload);
        return;
      }
      const pool = await fetchChannelPool(ch);
      const payload = await publicListPayload(sliceChannelPool(pool, url.searchParams.get('pg')), base, false, { manual: false });
      payload.channel = { id: ch.id, name: ch.name, icon: ch.icon, desc: ch.desc };
      sendJson(res, 200, payload);
      return;
    } catch (e) {
      sendJson(res, 502, { code: 0, msg: String(e.message || e), list: [] });
      return;
    }
  }

  if (p === '/api/vod/list' || p === '/api/vod/search' || p === '/api/vod/detail') {
    try {
      if (p === '/api/vod/list') {
        const data = await fetchList({
          pg: url.searchParams.get('pg'),
          t: url.searchParams.get('t'),
          year: parseYear(url.searchParams.get('year')),
        });
        sendJson(res, 200, await publicListPayload(data, base, false, {
          t: url.searchParams.get('t'),
          year: parseYear(url.searchParams.get('year')),
        }));
        return;
      }
      if (p === '/api/vod/search') {
        const wd = (url.searchParams.get('wd') || '').trim();
        if (!wd) { sendJson(res, 400, { ok: false, error: 'wd is required' }); return; }
        const data = await fetchSearch(wd.slice(0, 60), url.searchParams.get('pg'));
        sendJson(res, 200, await publicListPayload(data, base, false, { wd }));
        return;
      }
      const ids = (url.searchParams.get('ids') || '').trim();
      if (!/^(?:(?:\d{1,10}|4kcz-\d{1,8})|manual-[a-z0-9]{4,24})(?:,(?:(?:\d{1,10}|4kcz-\d{1,8})|manual-[a-z0-9]{4,24})){0,19}$/.test(ids)) {
        sendJson(res, 400, { ok: false, error: 'ids is required' });
        return;
      }
      const rows = await fetchDetail(ids);
      sendJson(res, 200, await publicDetailPayload(rows, base, true));
      return;
    } catch (e) {
      sendJson(res, 502, { code: 0, msg: String(e.message || e), list: [] });
      return;
    }
  }

  // ---- TVBox / MacCMS compatible endpoint ----
  if (p === '/api.php/provide/vod' || p === '/vod') {
    const ac = (url.searchParams.get('ac') || 'list').trim();
    const ids = (url.searchParams.get('ids') || '').trim();
    const wd = (url.searchParams.get('wd') || '').trim();
    try {
      if (ac === 'detail' && /^(?:(?:\d{1,10}|4kcz-\d{1,8})|manual-[a-z0-9]{4,24})(?:,(?:(?:\d{1,10}|4kcz-\d{1,8})|manual-[a-z0-9]{4,24})){0,19}$/.test(ids)) {
        const rows = await fetchDetail(ids);
        sendJson(res, 200, await publicDetailPayload(rows, base, true));
        return;
      }
      if (ac === 'detail' && wd) {
        const data = await fetchSearch(wd.slice(0, 60), url.searchParams.get('pg'), true);
        sendJson(res, 200, await publicListPayload(data, base, true, { wd }));
        return;
      }
      if (ac === 'detail') {
        const data = await fetchList({
          pg: url.searchParams.get('pg'),
          t: url.searchParams.get('t'),
          year: parseYear(url.searchParams.get('year')),
          withPlay: true,
        });
        sendJson(res, 200, await publicListPayload(data, base, true, {
          t: url.searchParams.get('t'),
          year: parseYear(url.searchParams.get('year')),
        }));
        return;
      }
      const data = await fetchList({
        pg: url.searchParams.get('pg'),
        t: url.searchParams.get('t'),
        year: parseYear(url.searchParams.get('year')),
      });
      sendJson(res, 200, await publicListPayload(data, base, false, {
        t: url.searchParams.get('t'),
        year: parseYear(url.searchParams.get('year')),
      }));
      return;
    } catch (e) {
      sendJson(res, 502, { code: 0, msg: String(e.message || e), list: [], class: CLASSES });
      return;
    }
  }

  // 未匹配的 API 路径必须返回 JSON 404，不能落到前端页面
  if (p.startsWith('/api')) {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  // Static frontend
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      if (!path.extname(rel)) {
        serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    serveFile(res, filePath);
  });
}

const server = http.createServer(requestHandler);

server.on('error', (e) => {
  console.error('[quying] server error:', (e && e.message) || e);
  process.exit(1);
});

// Vercel 等 Serverless 环境由平台调用 requestHandler，不需要自己监听端口
if (!process.env.VERCEL) {
  server.listen(PORT, HOST, () => {
    console.log(`[quying] listening on http://${HOST}:${PORT}`);
  });
}

// Vercel 要求入口模块的默认导出是函数或 server
export default requestHandler;

process.on('uncaughtException', (e) => {
  console.error('[quying] uncaughtException:', (e && e.message) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[quying] unhandledRejection:', (e && e.message) || e);
});
