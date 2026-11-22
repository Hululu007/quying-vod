import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LIVE_GROUP_NAMES = ['央视', '卫视', '地方', '体育', '影视', '少儿', '港澳台', '国际', '其他'];
export const LIVE_EPG_URL = 'http://epg.51zmt.top:8000/e.xml';
// 源顺序 = 线路优先级。前面的源先合并 → 频道的 lines[0] 来自可达率最高的源。
// 可达率实测：fmml_itv 100% / o_s_cn 73% / epg.pw cn 未测但官方精选。
export const DEFAULT_LIVE_SOURCES = [
  // === 国内台主力（高质量，实测可达率 >= 70%） ===
  { name: 'fmml_itv', url: 'https://m3u.ibert.me/fmml_itv.m3u', note: 'fanmingming/IPTV，中国移动官方 CDN，可达率 100%' },
  { name: 'fmml_ipv6', url: 'https://m3u.ibert.me/fmml_ipv6.m3u', note: 'fanmingming/IPTV IPv6 线路，公网 IPv6 环境可达' },
  { name: 'o_s_cn', url: 'https://m3u.ibert.me/o_s_cn.m3u', note: 'iptv.org 中国精选流，可达率 ~73%' },
  { name: 'cn', url: 'https://m3u.ibert.me/cn.m3u', note: 'epg.pw 自动整理中国源' },
  // === 原有兜底 ===
  { name: 'iptv-org', url: 'https://iptv-org.github.io/iptv/index.m3u', note: '官方 GitHub Pages，国际台丰富但国内台大量死链' },
  { name: 'ZBDS', url: 'https://live.zbds.top/tv/iptv4.m3u', note: '备用' },
  { name: 'myIPTV', url: 'https://raw.githubusercontent.com/suxuang/myIPTV/main/ipv4.m3u', note: '原始 github 直链，不再走 gh-proxy.org' },
];

// 已知完全不可用的源：vbskycn（gh-proxy.com 长期 403）、以及其它历史上连续挂掉的源。
// 这些在 DEFAULT_LIVE_SOURCES 中直接移除，用户显式设置 LIVE_SOURCES 可以覆盖。
export const DISABLED_LIVE_SOURCES = [
  { name: 'vbskycn', url: 'https://gh-proxy.com/raw.githubusercontent.com/vbskycn/iptv/refs/heads/master/tv/iptv4.m3u', reason: 'gh-proxy.com 镜像持续 403，清单完全不可达' },
  { name: 'fmml_index', url: 'https://m3u.ibert.me/fmml_index.m3u', reason: '0/40 可达率，host 58.248.112.205 全死' },
  { name: 'ycl_iptv', url: 'https://m3u.ibert.me/ycl_iptv.m3u', reason: '全是 RTSP/UDP 组播，公网不可用' },
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
    .replace(/^\s*[\[【][^\]】]*[\]】]\s*/, '')          // 去掉 [BD]、[高清] 这类前导标记
    .replace(/\s*[\[【(（][^\]】)）]*[\]】)）]\s*$/g, '') // 去掉所有 (720p)、[Not 24/7] 类后缀
    .replace(/\s+(?:50|60)\s*fps\b/gi, '')               // 独立后缀 " 50 FPS" / " 60 FPS"（先删，避免频道号被一起吞）
    .replace(/\s*hevc\b/gi, '')                           // HEVC
    .replace(/\s*plus\b/gi, '+')                          // 统一 Plus → +
    .replace(/\s+/g, ' ')
    .trim();
}

// 规范化频道名 → canonical key，用于跨源合并同名台。
// 核心是把不同源的写法（"CCTV 1"、"CCTV-1"、"cctv1"、"CCTV-1综合"）都映射到同一个 key。
function nameKey(value) {
  const raw = cleanName(value).toLowerCase();
  // CCTV/CETV 数字台：先去掉中文后缀（"综合"/"新闻"/"中文国际" 等），再统一取字母+数字
  // "cctv-1综合" → strip 中文 → "cctv-1" → 提取 → "cctv1"
  // "cctv 1" → 提取 → "cctv1"
  // "cctv5 plus" → 提取 → "cctv5+"
  const stripped = raw.replace(/[\u4e00-\u9fa5]+/g, '').trim(); // 先去掉所有中文
  const cctvMatch = stripped.match(/(cctv|cetv)\s*[-]?\s*(\d+)\s*(?:\+|plus)?/);
  if (cctvMatch) {
    const plus = /\+|plus/i.test(raw) ? '+' : '';
    return `${cctvMatch[1]}${cctvMatch[2]}${plus}`; // cctv1 / cetv3 / cctv5+
  }
  // CGTN / BTV 北京台（无数字或有特殊词）
  if (/^cgtn/.test(raw)) return 'cgtn';
  if (/^btv\b|brtv|北京卫视/.test(raw)) return '北京卫视';
  // 卫视名：提取 "XX卫视" 核心（允许中间有 "BRTV"/"dragon tv" 这类杂质）
  const weishiMatch = raw.match(/([\u4e00-\u9fa5]{2,8}卫视)/);
  if (weishiMatch) return weishiMatch[1];
  // 东方卫视 / Dragon TV 特例
  if (/东方卫视|dragon\s*tv/i.test(raw)) return '东方卫视';
  // 通用：去空格去标点 → 纯文本 key
  return raw.replace(/[\s\-_–—·•.,!?()（）\[\]【】]+/g, '').replace(/\d+p?$/, '');
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

// 上游清单里常见的垃圾/占位条目：支持作者、打赏、测试、广告流、donation 等。
// 命中这些的频道直接过滤，不进入任何分组。
const JUNK_NAME_RE = /^(支持作者|打赏|捐赠|赞赏|赞助|作者支持|test|测试|demo|dummy|sample|placeholder|ad$|广告|donate|donation|thanks?|请收藏|扫码|关注|公众号|VX|wx|wechat|qrcode|免费|福利|破解|vip|会员)$/i;
const JUNK_RAW_GROUP_RE = /(支持作者|打赏|捐赠|赞赏|赞助|公众号|VX|wx|wechat|扫码|免费福利)/i;

// 省级/直辖市名：频道名里出现这些 = 地方台，不管 rawGroup 标了什么。
const PROVINCE_NAMES = ['北京', '天津', '上海', '重庆',
  '河北', '河南', '山东', '山西', '陕西', '甘肃', '青海', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南',
  '广西', '内蒙古', '西藏', '宁夏', '新疆',
  '南京', '广州', '深圳', '成都', '杭州', '宁波', '苏州', '武汉', '长沙', '青岛', '大连', '厦门', '福州', '太原', '西安', '沈阳', '长春', '哈尔滨', '郑州', '合肥', '济南', '石家庄', '南宁', '昆明', '贵阳', '兰州', '银川', '西宁', '乌鲁木齐', '拉萨', '呼和浩特', '包头', '鄂尔多斯', '三亚', '珠海', '中山', '佛山', '东莞', '无锡', '常州', '徐州', '南通', '温州', '绍兴', '金华', '台州', '嘉兴', '湖州', '丽水', '衢州', '舟山', '漳州', '泉州', '莆田', '龙岩', '三明', '南平', '宁德', '萍乡', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶'];

// 央视真正的标识：频道名必须显式命中。rawGroup 兜底条件更严格。
// 关键词前后加边界约束，避免 "DanceTV" 小写 "dancetv" 里包含 "cetv" 这种误命中。
const CCTV_NAME_RE = /(^|[\s\-_])(cctv)([\s\-_]|[-+]?\d|$)|(^|[\s\-_])cetv-\d|cgtn|央视|央視|中国中央電?视|china\s*central/i;
// 全英文频道里的"伪央视"排除：Red CCTV（英国纪录片）、WCETV（美国教育）、DanceTV（EDM）等
const CCTV_ENGLISH_BLACKLIST_RE = /(red\s+cctv|wcetv|dancetv|^cetv\b[^-]|^cctv\b[^0-9\-+])/i;

// 卫视名识别：频道名含 "卫视"/"衛視" 或英文 Satellite TV/Channel
const WEISHI_NAME_RE = /(卫视|衛視|satellite\s*(?:tv|channel)?)/i;

// 港澳台：频道名里显式命中台湾/澳门/香港专业台关键词。
// 上游 rawGroup 标 "港澳台频道" 不再独立生效（会把爱奇艺、半岛新闻这类错收进来）。
const HKMT_NAME_RE = /(香港|澳门|澳門|台湾|台灣|凤凰|鳳凰|tvb|hong\s*kong|macau|taiwan|now\s*(?:tv|news)|亚视|亞視|atel|八達通|澳亚|澳門|東森|东森|大爱|大愛|番薯|八大|八大|台视|台視|华视|華視|民视|民視|公视|公視|纬来|緯來|中天|非凡|壹電視|民間全民|TVBS|三立|东洋|年代|三立|卫视中文|衛視中文|东风|東風|华娱|華娛|星空|channel\s*v|mtv\s*taiwan)/i;
// 港澳台黑名单：上游 rawGroup 标港澳台但频道名明显不是（爱奇艺是大陆的、半岛新闻是中东的）
const HKMT_BLACKLIST_RE = /(爱奇艺|iqiyi|半岛|al\s*jazeera|aljazeera|卡达|qatar)/i;

// 体育
const SPORTS_RE = /(体育|體育|足球|篮球|籃球|网球|網球|斯诺克|排球|赛车|賽車|高尔夫|sports?|espn|nba|nfl|nhl|mlb|atp|wta|f1|uefa|cctv-5|cctv5)/i;

// 少儿/动画
const KIDS_RE = /(少儿|少兒|儿童|兒童|卡通|动画|動畫|幼儿|幼兒|baby|kids?|cartoon|nick|disney|boomerang|cctv-14|cctv14|cbeebies)/i;

// 影视/电影
const MOVIES_RE = /(影视|影視|电影|電影|影院|剧场|劇場|影院|劇院|movies?|films?|cinema|hbo|showtime|starz)/i;

export function classifyLiveGroup(name, rawGroup = '') {
  const cleanName = String(name || '').normalize('NFKC').trim();
  const cleanGroup = String(rawGroup || '').normalize('NFKC').trim();
  const lowerName = cleanName.toLowerCase();
  const lowerGroup = cleanGroup.toLowerCase();

  // 1) 垃圾过滤
  if (JUNK_NAME_RE.test(lowerName) || JUNK_RAW_GROUP_RE.test(lowerGroup)) return '';

  // 2) 频道名里有省级/直辖市名 → 地方台（优先级最高，覆盖上游 rawGroup 的"央视"误标）
  //    精确匹配：先尝试城市名（2 字更具体），再尝试省/直辖市名
  if (cleanName.length >= 2) {
    // 频道名含 "卫视" → 卫视，除非是港澳台台（凤凰/星空/东风/华娱等）
    if (/卫视|衛視/.test(cleanName)) {
      if (CCTV_NAME_RE.test(cleanName)) return '央视';
      if (HKMT_NAME_RE.test(cleanName) && !HKMT_BLACKLIST_RE.test(cleanName)) return '港澳台';
      return '卫视';
    }
    for (const p of PROVINCE_NAMES) {
      if (cleanName.includes(p)) {
        // 省市命中，但频道名明确是央视的特殊处理
        if (CCTV_NAME_RE.test(cleanName) && !CCTV_ENGLISH_BLACKLIST_RE.test(cleanName)) return '央视';
        return '地方';
      }
    }
  }

  // 3) 央视：频道名必须显式命中 CCTV/CETV/CGTN/央视/央視，且不是全英文伪央视
  if (CCTV_NAME_RE.test(cleanName) && !CCTV_ENGLISH_BLACKLIST_RE.test(cleanName)) return '央视';

  // 4) 港澳台：频道名命中台湾/澳门/香港台关键词，排除黑名单
  if (HKMT_NAME_RE.test(cleanName) && !HKMT_BLACKLIST_RE.test(cleanName)) return '港澳台';

  // 5) 卫视：频道名含 "卫视"/"衛視"/Satellite
  if (WEISHI_NAME_RE.test(cleanName)) return '卫视';

  // 6) 体育 / 少儿 / 影视：频道名关键词匹配
  if (SPORTS_RE.test(cleanName)) return '体育';
  if (KIDS_RE.test(cleanName)) return '少儿';
  if (MOVIES_RE.test(cleanName)) return '影视';

  // 7) 上游 rawGroup 兜底：仅限频道名不明确时，且兜底条件更严格
  if (lowerGroup) {
    // 7a) 央视兜底：rawGroup 含"央视"，**且频道名里必须含"中"字**（中国/中华/中央）
    //     避免 "法治天地"、"熊猫直播"、"金鹰纪实" 这类被上游乱标进央视的条目
    if (CCTV_NAME_RE.test(cleanGroup) && !PROVINCE_NAMES.some((p) => cleanName.includes(p)) && /中|中央/.test(cleanName)) return '央视';
    if (WEISHI_NAME_RE.test(cleanGroup)) return '卫视';
    if (HKMT_NAME_RE.test(cleanGroup) && !HKMT_BLACKLIST_RE.test(lowerGroup)) return '港澳台';
    if (SPORTS_RE.test(cleanGroup)) return '体育';
    if (KIDS_RE.test(cleanGroup)) return '少儿';
    if (MOVIES_RE.test(cleanGroup)) return '影视';
  }

  // 8) 全英文 → 国际
  if (/^[\x00-\x7f]+$/.test(cleanName) || /international|documentary|music|general|entertainment|lifestyle|religion|travel|education|culture|business|weather/i.test(cleanName)) return '国际';

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
    const group = classifyLiveGroup(name, rawGroup);
    if (!group) continue;  // 垃圾/不可分类条目过滤
    rows.push({
      name,
      tvgId: String(attrs['tvg-id'] || '').trim(),
      logo: httpUrl(attrs['tvg-logo']),
      rawGroup,
      group,
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
  // HTTP 混合内容 + 源健康度淘汰：
  // 1) 如果一个频道有多线路且含 HTTPS，优先只留 HTTPS（生产 HTTPS 页面 HTTP 会被浏览器拦）
  // 2) 如果一个频道只剩 HTTP 线路，保留下但后端代理兜底（/live-proxy.m3u8）
  for (const channel of byName.values()) {
    if (channel.lines.length > 1) {
      const httpsLines = channel.lines.filter((l) => /^https:/i.test(l.url));
      if (httpsLines.length > 0 && httpsLines.length < channel.lines.length) {
        channel.lines = httpsLines;
      }
    }
    // 每个频道最多保留 5 条线路（避免合并过多垃圾备选）
    if (channel.lines.length > 5) channel.lines = channel.lines.slice(0, 5);
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
  constructor({ sources = DEFAULT_LIVE_SOURCES, fetchText, ttl = 21600000, disableLocal = false } = {}) {
    if (typeof fetchText !== 'function') throw new Error('fetchText is required');
    this.sources = sources;
    this.fetchText = fetchText;
    this.ttl = Math.max(0, Number(ttl) || 0);
    this.disableLocal = disableLocal;
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
    if (!entries.length && !this.disableLocal) {
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
