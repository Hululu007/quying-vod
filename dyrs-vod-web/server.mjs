// 趣影 VOD 聚合服务：适配 4K 站（HTML）与暴风站（MacCMS JSON API），
// 输出统一的 TVBox / MacCMS 兼容接口。列表与详情来自上游公开页面，
// 播放地址实时解析且不落库；海报按需走同源代理。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
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
};
// A head type maps to its headline id for 4K fallback and client display.
const HEAD_TO_HEADLINE = { 20: '1', 30: '2', 45: '3', 39: '4', 58: '5' };
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
  { id: '1', name: '电影' },
  { id: '2', name: '电视剧' },
  { id: '3', name: '综艺' },
  { id: '4', name: '动漫' },
  { id: '5', name: '短剧' },
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
  const play = withPlay ? rewritePlay(v, base) : { from: '趣影一线', url: '' };
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

async function fetchList({ pg, t, year, withPlay }) {
  // 查询键必须用字符串，否则原始二级分类会全部落到同一个 [object Object] 缓存上。
  const cat = categoryParam(t);
  const catKey = cat ? `${cat.kind}:${cat.value}` : '';
  const key = `list:v5:${withPlay ? 1 : 0}:${parsePage(pg)}:${PAGE_SIZE}:${catKey}:${parseYear(year)}`;
  return catalogQuery(key, TTL.list, () => fetchListLive({ pg, t, year, withPlay }));
}

async function fetchDetail(ids) {
  const idList = String(ids).split(',');
  const key = `detail:${idList.join(',')}`;
  const data = await catalogQuery(key, TTL.detail, async () => {
    const rows = await fetchDetailLive(ids);
    return { page: 1, pagecount: 1, total: rows.length, list: rows };
  });
  return data.list;
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
  if (!origin) return true;
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
    if (p === '/api/admin/settings' && method === 'PUT') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, data: await adminStore.updateSettings(body) });
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

  if (req.method !== 'GET') {
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
  if (p === '/api/vod/list' || p === '/api/vod/search' || p === '/api/vod/detail') {
    try {
      if (p === '/api/vod/list') {
        const data = await fetchList({
          pg: url.searchParams.get('pg'),
          t: url.searchParams.get('t'),
          year: parseYear(url.searchParams.get('year')),
        });
        sendJson(res, 200, listPayload(data, base, false));
        return;
      }
      if (p === '/api/vod/search') {
        const wd = (url.searchParams.get('wd') || '').trim();
        if (!wd) { sendJson(res, 400, { ok: false, error: 'wd is required' }); return; }
        const data = await fetchSearch(wd.slice(0, 60), url.searchParams.get('pg'));
        sendJson(res, 200, listPayload(data, base, false));
        return;
      }
      const ids = (url.searchParams.get('ids') || '').trim();
      if (!/^(?:\d{1,10}|4kcz-\d{1,8})(?:,(?:\d{1,10}|4kcz-\d{1,8})){0,19}$/.test(ids)) {
        sendJson(res, 400, { ok: false, error: 'ids is required' });
        return;
      }
      const rows = await fetchDetail(ids);
      sendJson(res, 200, {
        code: 1,
        msg: '数据列表',
        page: 1,
        pagecount: 1,
        limit: PAGE_SIZE,
        total: rows.length,
        list: rows.map((v) => normalizeItem(v, base, true)).filter(Boolean),
        class: CLASSES,
      });
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
      if (ac === 'detail' && /^(?:\d{1,10}|4kcz-\d{1,8})(?:,(?:\d{1,10}|4kcz-\d{1,8})){0,19}$/.test(ids)) {
        const rows = await fetchDetail(ids);
        sendJson(res, 200, {
          code: 1, msg: '数据列表', page: 1, pagecount: 1, limit: PAGE_SIZE, total: rows.length,
          list: rows.map((v) => normalizeItem(v, base, true)).filter(Boolean),
          class: CLASSES,
        });
        return;
      }
      if (ac === 'detail' && wd) {
        const data = await fetchSearch(wd.slice(0, 60), url.searchParams.get('pg'), true);
        sendJson(res, 200, listPayload(data, base, true));
        return;
      }
      if (ac === 'detail') {
        const data = await fetchList({
          pg: url.searchParams.get('pg'),
          t: url.searchParams.get('t'),
          year: parseYear(url.searchParams.get('year')),
          withPlay: true,
        });
        sendJson(res, 200, listPayload(data, base, true));
        return;
      }
      const data = await fetchList({
        pg: url.searchParams.get('pg'),
        t: url.searchParams.get('t'),
        year: parseYear(url.searchParams.get('year')),
      });
      sendJson(res, 200, listPayload(data, base, false));
      return;
    } catch (e) {
      sendJson(res, 502, { code: 0, msg: String(e.message || e), list: [], class: CLASSES });
      return;
    }
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
