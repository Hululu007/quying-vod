import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LIVE_GROUP_NAMES = ['央视', '卫视', '地方', '体育', '影视', '少儿', '港澳台', '国际', '其他'];
export const LIVE_EPG_URL = 'http://epg.51zmt.top:8000/e.xml';
export const DEFAULT_LIVE_SOURCES = [
  { name: 'ZBDS', url: 'https://live.zbds.top/tv/iptv4.m3u' },
  { name: 'vbskycn', url: 'https://gh-proxy.com/raw.githubusercontent.com/vbskycn/iptv/refs/heads/master/tv/iptv4.m3u' },
  { name: 'iptv-org', url: 'https://iptv-org.github.io/iptv/index.m3u' },
  { name: 'myIPTV', url: 'https://gh-proxy.org/raw.githubusercontent.com/suxuang/myIPTV/main/ipv4.m3u' },
];

// 可选本地 assets/ 兜底：用户可在 dyrs-vod-web/assets/ 或 public/assets/ 放置 .m3u 文件，
// 当远端源全部不可用时仍有基础频道。优先级低于远端，远端同名频道不会被本地覆盖。
function readLocalLiveSources() {
  const candidates = [
    path.join(__dirname, 'assets'),
    path.join(__dirname, '..', 'assets'),
    path.join(__dirname, 'public', 'assets'),
  ];
  const sources = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of entries) {
      if (!file.isFile() || !/\.m3u$/i.test(file.name)) continue;
      const fullPath = path.join(dir, file.name);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      let text;
      try { text = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
      if (!text || !text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) continue;
      sources.push({ name: `本地-${path.basename(file.name, path.extname(file.name))}`, text });
    }
  }
  return sources;
}

function cleanName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/\s*[\[【(（](?:hd|fhd|uhd|4k|1080p|高清|超清)[\]】)）]\s*$/i, '')
    .replace(/\s+(?:hd|fhd|uhd|4k|1080p)$/i, '')
    .trim();
}

function nameKey(value) {
  return cleanName(value).toLowerCase().replace(/[\s\-_–—·•]+/g, '');
}

function httpUrl(value, { media = false } = {}) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) raw = `https:${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (media && /\.flv$/i.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function classifyLiveGroup(name, rawGroup = '') {
  const text = `${rawGroup} ${name}`.normalize('NFKC').toLowerCase();
  if (/港澳台|香港|澳门|台湾|台灣|凤凰|鳳凰|tvb|hong kong|macau|taiwan/.test(text)) return '港澳台';
  if (/体育|體育|足球|篮球|籃球|网球|網球|sports?|espn|nba/.test(text)) return '体育';
  if (/少儿|少兒|儿童|兒童|卡通|动画|動畫|kids?|cartoon|baby/.test(text)) return '少儿';
  if (/影视|影視|电影|電影|影院|剧场|劇場|movies?|films?|cinema/.test(text)) return '影视';
  if (/卫视|衛視|satellite/.test(text)) return '卫视';
  if (/央视|央視|cctv|cgtn|cetv/.test(text)) return '央视';
  if (/地方|北京|天津|上海|重庆|河北|河南|山东|山西|陕西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|湖北|湖南|广东|海南|四川|贵州|云南|甘肃|青海|广西|内蒙古|西藏|宁夏|新疆/.test(text)) return '地方';
  if (/^[\x00-\x7f]+$/.test(`${rawGroup}${name}`) || /international|news|documentary|music|general|entertainment|lifestyle|religion|shop|travel|education|culture|business|weather/.test(text)) return '国际';
  return '其他';
}

function splitExtinf(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') quote = quote === ch ? '' : (quote || ch);
    if (ch === ',' && !quote) return [line.slice(0, i), line.slice(i + 1).trim()];
  }
  return [line, ''];
}

function extinfAttributes(value) {
  const attrs = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match;
  while ((match = re.exec(value))) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return attrs;
}

export function parseM3U(text, source = '') {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^#EXTINF:/i.test(lines[i].trim())) continue;
    const [head, commaName] = splitExtinf(lines[i].trim());
    const attrs = extinfAttributes(head);
    const name = cleanName(commaName || attrs['tvg-name']);
    let url = '';
    let cursor = i;
    while (++cursor < lines.length) {
      const candidate = lines[cursor].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      url = httpUrl(candidate, { media: true });
      i = cursor;
      break;
    }
    if (!name || !url) continue;
    const rawGroup = String(attrs['group-title'] || '').normalize('NFKC').trim();
    rows.push({
      name,
      tvgId: String(attrs['tvg-id'] || '').trim(),
      logo: httpUrl(attrs['tvg-logo']),
      rawGroup,
      group: classifyLiveGroup(name, rawGroup),
      url,
      source: String(source || '').trim(),
    });
  }
  return rows;
}

export function mergeLiveChannels(entries) {
  const byName = new Map();
  for (const entry of entries || []) {
    const name = cleanName(entry && entry.name);
    const url = httpUrl(entry && entry.url, { media: true });
    const key = nameKey(name);
    if (!name || !url || !key) continue;
    let channel = byName.get(key);
    if (!channel) {
      channel = {
        id: `live-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`,
        name,
        tvgId: String(entry.tvgId || '').trim(),
        logo: httpUrl(entry.logo),
        group: entry.group || classifyLiveGroup(name, entry.rawGroup),
        lines: [],
      };
      byName.set(key, channel);
    }
    if (!channel.tvgId && entry.tvgId) channel.tvgId = String(entry.tvgId).trim();
    if (!channel.logo && entry.logo) channel.logo = httpUrl(entry.logo);
    if (!channel.lines.some((line) => line.url === url)) {
      channel.lines.push({ url, source: String(entry.source || '').trim() || '直播源' });
    }
  }
  const order = new Map(LIVE_GROUP_NAMES.map((name, index) => [name, index]));
  return [...byName.values()].sort((a, b) =>
    (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99)
    || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

export function queryLiveChannels(channels, { group = '', wd = '', page = 1, size = 60 } = {}) {
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(size, 10) || 60));
  const key = nameKey(wd);
  const filtered = (channels || []).filter((channel) =>
    (!group || channel.group === group) && (!key || nameKey(channel.name).includes(key)));
  const total = filtered.length;
  const pagecount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(1, Math.min(pagecount, Number.parseInt(page, 10) || 1));
  return {
    list: filtered.slice((current - 1) * pageSize, current * pageSize),
    total,
    page: current,
    pagecount: pagecount,
    size: pageSize,
  };
}

function m3uAttr(value) {
  return String(value || '').replace(/["\r\n]/g, ' ').trim();
}

export function buildLiveM3U(channels) {
  const lines = [`#EXTM3U x-tvg-url="${LIVE_EPG_URL}"`];
  for (const channel of channels || []) {
    for (const line of channel.lines || []) {
      lines.push(`#EXTINF:-1 tvg-id="${m3uAttr(channel.tvgId)}" tvg-name="${m3uAttr(channel.name)}" tvg-logo="${m3uAttr(channel.logo)}" group-title="${m3uAttr(channel.group)}",${channel.name.replace(/[\r\n]/g, ' ')}`);
      lines.push(line.url);
    }
  }
  return `${lines.join('\n')}\n`;
}

export class LiveCollector {
  constructor({ sources = DEFAULT_LIVE_SOURCES, fetchText, ttl = 21600000 } = {}) {
    if (typeof fetchText !== 'function') throw new Error('fetchText is required');
    this.sources = sources;
    this.fetchText = fetchText;
    this.ttl = Math.max(0, Number(ttl) || 0);
    this.snapshot = null;
    this.inflight = null;
    this.retryAfter = 0;
  }

  async collect() {
    const sources = [];
    const entries = [];
    await Promise.all(this.sources.map(async (source) => {
      try {
        const text = await this.fetchText(source.url);
        const rows = parseM3U(text, source.name);
        if (!rows.length) throw new Error('清单无有效频道');
        entries.push(...rows);
        sources.push({ name: source.name, url: source.url, ok: true, count: rows.length });
      } catch (error) {
        sources.push({ name: source.name, url: source.url, ok: false, count: 0, error: String((error && error.message) || error).trim() });
      }
    }));
    let allRemoteDown = false;
    if (!entries.length) {
      // 所有远端源均失败 — 尝试本地 assets/ 兜底
      allRemoteDown = true;
      const local = readLocalLiveSources();
      for (const src of local) {
        const rows = parseM3U(src.text, src.name);
        if (rows.length) {
          entries.push(...rows);
          sources.push({ name: src.name, url: '(本地)', ok: true, count: rows.length, local: true });
        }
      }
    }
    if (!entries.length) throw new Error('所有直播清单源暂不可用');
    const channels = mergeLiveChannels(entries);
    const groups = LIVE_GROUP_NAMES.map((name) => ({ id: name, name, count: channels.filter((channel) => channel.group === name).length })).filter((group) => group.count > 0);
    return {
      updatedAt: new Date().toISOString(),
      stale: allRemoteDown,
      channels,
      groups,
      sources: this.sources.map((source) => sources.find((item) => item.url === source.url)).concat(sources.filter((item) => item.local)),
    };
  }

  async getSnapshot({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.snapshot) {
      if (this.ttl > 0 && now - Date.parse(this.snapshot.updatedAt) < this.ttl) return this.snapshot;
      if (now < this.retryAfter) return { ...this.snapshot, stale: true };
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.collect().then((snapshot) => {
      this.snapshot = snapshot;
      this.retryAfter = 0;
      return snapshot;
    }).catch((error) => {
      this.retryAfter = Date.now() + 60000;
      if (this.snapshot) return { ...this.snapshot, stale: true };
      throw error;
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}
