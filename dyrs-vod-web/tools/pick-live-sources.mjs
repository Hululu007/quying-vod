#!/usr/bin/env node
// 卫视/地方台可达线路精选：拉清单 → 探测 → 输出 M3U
// 用法：
//   node pick-live-sources.mjs                # 直连探测，输出 weishi-live.m3u + defang-live.m3u
//   node pick-live-sources.mjs --via=https://xxx  # 经线上代理探测
//   GROUPS=weishi node pick-live-sources.mjs  # 只跑卫视
//   GROUPS=defang node pick-live-sources.mjs  # 只跑地方
//   CONCURRENCY=16 TIMEOUT_MS=4000 node ...
//
// 输出文件放 assets/ 下（脚本同级 ../assets/），文件名带 -live.m3u 后缀 → live.mjs 自动识别为 always 源。

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 4000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const VIA = (process.argv.find((a) => a.startsWith('--via=')) || '').slice(6).replace(/\/$/, '');
const GROUP_FILTER = (process.env.GROUPS || '').trim(); // 'weishi' / 'defang' / '' 全部

// 与 live.mjs DEFAULT_LIVE_SOURCES 保持一致的候选源。
// 注意：本机网络常无法直连 raw.githubusercontent.com，GitHub 仓库统一走 jsDelivr CDN
// （内容与 raw 完全一致）；线上服务端在海外，live.mjs 仍使用 raw 直连。
const SOURCES = [
  'https://m3u.ibert.me/o_s_cn.m3u',
  'https://m3u.ibert.me/fmml_itv.m3u',
  'https://cdn.jsdelivr.net/gh/vbskycn/iptv@master/tv/iptv4.m3u',
  'https://yonsm.github.io/IPTV/online/gwjx.m3u8',
  'https://cdn.jsdelivr.net/gh/Guovin/iptv-api@gd/output/result.m3u',
  'https://live.zbds.top/tv/iptv4.m3u',
  'https://iptv-org.github.io/iptv/countries/cn.m3u',
];

// 单响应体积上限：合法 m3u8 清单/分片探针都在 MB 级以内。
// 曾遇到上游持续吐海量数据撑爆字符串上限（ERR_STRING_TOO_LONG）导致整轮探测崩溃，必须主动截断。
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function requestOnce(url, { timeout = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(Buffer.from(d));
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function fetchFollow(url, { timeout = 15000, maxRedirects = 4, headers = {} } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const res = await requestOnce(current, { timeout, headers });
    if (res.redirect) { current = res.redirect; continue; }
    return res;
  }
  throw new Error('too many redirects');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 清单源价值高、数量少，网络抖动时单次超时不应让整源缺席：最多 3 次尝试，退避 1.5s/3s
async function fetchListWithRetry(url, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetchFollow(url, { timeout: 25000 });
      if (res.status >= 200 && res.status < 300 && res.body) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw lastError;
}

async function probeDirect(rawUrl) {
  try {
    const res = await fetchFollow(rawUrl, { timeout: TIMEOUT_MS, headers: { Range: 'bytes=0-65535' } });
    const text = (res.body || '').replace(/^\uFEFF/, '').trimStart();
    const ok = res.status >= 200 && res.status < 400 && text.startsWith('#EXTM3U');
    return { ok, ms: res.ms || 0 };
  } catch {
    return { ok: false, ms: 0 };
  }
}

async function probeViaProxy(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${VIA}/live-proxy.m3u8?url=${encodeURIComponent(rawUrl)}`, { signal: controller.signal });
    const text = await res.text();
    const ok = res.ok && text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
    return { ok, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const probe = VIA ? probeViaProxy : probeDirect;

function parseM3U(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let pendingName = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      pendingName = line.split(',').pop().trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pendingName && /^https?:/i.test(line)) rows.push({ name: pendingName, url: line });
    pendingName = '';
  }
  return rows;
}

function cleanName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^\s*[[【][^\]】]*[\]】]\s*/, '')
    .replace(/\s*[[【(（][^\]】)）]*[\]】)）]\s*$/g, '')
    .replace(/\s+(?:50|60)\s*fps\b/gi, '')
    .replace(/\s*hevc\b/gi, '')
    .replace(/\s*plus\b/gi, '+')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyOf(name) {
  return cleanName(name).toLowerCase().replace(/[\s\-_–—·•.,!?()（）\[\]【】]+/g, '').replace(/\d+p?$/, '');
}

// 卫视识别
function isWeishi(name) {
  const n = name.normalize('NFKC');
  return /卫视|衛視|satellite\s*(?:tv|channel)?/i.test(n) &&
    !/凤凰|鳳凰|tvb|星空|东风|東風|华娱|華娛|channel\s*v/i.test(n);
}

// 地方台识别（基于 live.mjs 的 PROVINCE_NAMES + LOCAL 特征）
const PROVINCE_NAMES = ['北京', '天津', '上海', '重庆',
  '河北', '河南', '山东', '山西', '陕西', '甘肃', '青海', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南',
  '广西', '内蒙古', '西藏', '宁夏', '新疆',
  '南京', '广州', '深圳', '成都', '杭州', '宁波', '苏州', '武汉', '长沙', '青岛', '大连', '厦门', '福州', '太原', '西安', '沈阳', '长春', '哈尔滨', '郑州', '合肥', '济南', '石家庄', '南宁', '昆明', '贵阳', '兰州', '银川', '西宁', '乌鲁木齐', '拉萨', '呼和浩特', '包头', '鄂尔多斯', '三亚', '珠海', '中山', '佛山', '东莞', '无锡', '常州', '徐州', '南通', '温州', '绍兴', '金华', '台州', '嘉兴', '湖州', '丽水', '衢州', '舟山', '漳州', '泉州', '莆田', '龙岩', '三明', '南平', '宁德', '萍乡', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶'];

const LOCAL_NOISE_RE = /(春晚|相声|小品|演唱会|电影|电视剧|纪录片|合集|精选|音乐|MV|广告|测试|年\d+月|第\d+季)/i;
const LOCAL_FEATURE_RE = /(新闻综合|综合频道|公共频道|都市频道|生活频道|民生频道|文旅频道|广播电视台|电视台$)/;
const CCTV_RE = /(cctv|cetv|央视|中央|cgtn)/i;
const HKMT_RE = /(香港|澳门|台湾|凤凰|tvb|hong\s*kong|macau|taiwan)/i;

function isDefang(name) {
  const n = name.normalize('NFKC');
  if (CCTV_RE.test(n)) return false;
  if (HKMT_RE.test(n)) return false;
  if (isWeishi(n)) return false; // 卫视单独一组
  if (LOCAL_NOISE_RE.test(n)) return false;
  for (const p of PROVINCE_NAMES) if (n.includes(p)) return true;
  if (LOCAL_FEATURE_RE.test(n)) return true;
  // 纯中文 + 不含卫视/央视 → 大概率地方台
  if (/[\u4e00-\u9fa5]{2,}/.test(n) && !/卫视|衛視|卫视/.test(n)) return true;
  return false;
}

async function pool(list, size, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const i = cursor; cursor += 1;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
  return out;
}

function m3uLine(name, url, group) {
  return `#EXTINF:-1 group-title="${group}",${name}\n${url}`;
}

async function main() {
  console.log(`模式: ${VIA ? '经代理 ' + VIA : '本机直连'} | 并发 ${CONCURRENCY} | 超时 ${TIMEOUT_MS}ms`);

  // 1) 拉所有清单
  console.log('\n拉取清单源…');
  const allRows = [];
  for (const src of SOURCES) {
    try {
      const res = await fetchListWithRetry(src);
      const rows = parseM3U(res.body || '');
      rows.forEach((r) => allRows.push({ ...r, src }));
      console.log(`  OK  ${src.split('/').slice(-2).join('/').padEnd(30)} ${rows.length} 条`);
    } catch (e) {
      console.log(`  NO  ${src.split('/').slice(-2).join('/').padEnd(30)} ${e.message}`);
    }
  }

  // 2) 按频道名合并线路（去重 + 限 5 条）
  const byName = new Map();
  for (const row of allRows) {
    const key = keyOf(row.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, { rawName: row.name, urls: [] });
    const ch = byName.get(key);
    if (!ch.urls.includes(row.url) && ch.urls.length < 5) ch.urls.push(row.url);
  }
  const allChannels = [...byName.values()];

  // 3) 分卫视 / 地方台
  const weishi = allChannels.filter((c) => isWeishi(c.rawName));
  const defang = allChannels.filter((c) => isDefang(c.rawName));
  console.log(`\n候选：卫视 ${weishi.length} 个 | 地方台 ${defang.length} 个`);

  const groups = [];
  if (!GROUP_FILTER || GROUP_FILTER.includes('weishi')) groups.push({ key: 'weishi', label: '卫视', list: weishi });
  if (!GROUP_FILTER || GROUP_FILTER.includes('defang')) groups.push({ key: 'defang', label: '地方', list: defang });

  // 4) 逐组探测 + 立即写文件，防止超时丢失已完成数据
  const outDir = path.join(__dirname, '..', 'assets');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const report = { generatedAt: new Date().toISOString(), mode: VIA ? `via ${VIA}` : 'direct', groups: {} };

  for (const g of groups) {
    console.log(`\n【${g.label}】探测 ${g.list.length} 个频道…`);
    const out = []; // { name, url }
    let done = 0;
    const total = g.list.length;
    const fname = `${g.key === 'weishi' ? 'weishi' : 'defang'}-live.m3u`;
    const fpath = path.join(outDir, fname);
    // 检查点：每完成 25 个频道就落盘一次，防止后期异常（如上游超大响应/进程被杀）丢掉整轮成果
    const writeCheckpoint = () => {
      const m3u = ['#EXTM3U'];
      for (const o of out) m3u.push(m3uLine(o.name, o.url, g.label));
      fs.writeFileSync(fpath, m3u.join('\n') + '\n', 'utf8');
    };
    await pool(g.list, CONCURRENCY, async (ch) => {
      let found = false;
      for (const url of ch.urls) {
        const r = await probe(url);
        if (r.ok) { out.push({ name: cleanName(ch.rawName), url }); found = true; break; }
      }
      done += 1;
      if (done % 50 === 0 || done === total) {
        console.log(`  进度 ${done}/${total} ... 已达 ${out.length} 条`);
      }
      if (done % 25 === 0) writeCheckpoint();
      return found;
    });
    console.log(`  可达 ${out.length}/${total}`);
    for (const o of out) console.log(`    OK  ${o.name.padEnd(16)} ${o.url}`);

    // 最终写 M3U + 累计 JSON 报告
    writeCheckpoint();
    console.log(`  ✓ 已写入 ${fpath}`);

    report.groups[g.key] = { label: g.label, sampled: total, playable: out.length, entries: out };
    fs.writeFileSync(path.join(outDir, 'pick-live-report.json'), JSON.stringify(report, null, 2), 'utf8');
  }

  console.log('\n全部完成！报告文件在 assets/pick-live-report.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
