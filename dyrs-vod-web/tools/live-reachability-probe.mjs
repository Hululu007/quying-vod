#!/usr/bin/env node
// 直播源可达率探测：在目标服务器（香港 CN2 / 国内 / 本地）上直接跑，输出与线上基线可对比的报告。
//
// 用法：
//   node live-reachability-probe.mjs                       # 直连探测（在本机出网）
//   node live-reachability-probe.mjs --via=https://quying.de5.net   # 经线上 /live-proxy.m3u8 探测（对照 Vercel 出网）
//   SAMPLE=5 node live-reachability-probe.mjs              # 每组只抽 5 个台，快速验证
//   CONCURRENCY=12 TIMEOUT_MS=8000 node live-reachability-probe.mjs
//
// 输出：终端表格 + 当前目录 live-report.json
// 指标：每台「至少一条线路可用」算可播（与前端播放逻辑一致），另统计 HTTPS 分片占比（决定能否让浏览器直连省带宽）。

import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 6000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const SAMPLE = Number(process.env.SAMPLE || 0); // 0 = 全量抽样上限
const VIA = (process.argv.find((a) => a.startsWith('--via=')) || '').slice(6).replace(/\/$/, '');

// 与线上默认源保持一致（含本地精选央视清单的线上地址；本地跑时读不到就跳过）
const SOURCES = [
  'https://m3u.ibert.me/o_s_cn.m3u',
  'https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u',
  'https://iptv-org.github.io/iptv/countries/cn.m3u',
  'https://live.zbds.top/tv/iptv4.m3u',
  'https://iptv-org.github.io/iptv/categories/sports.m3u',
  'https://iptv-org.github.io/iptv/categories/kids.m3u',
  'https://iptv-org.github.io/iptv/categories/movies.m3u',
];
const MIRRORS = {
  'raw.githubusercontent.com': 'https://cdn.jsdelivr.net/gh',
};

// 线上 Vercel 出网基线（2026-11 实测，经 /live-proxy.m3u8）：用于报告对比
const BASELINE = {
  央视: '8/22 可播（36%）',
  卫视: '约 50%',
  地方: '约 35%',
};

function requestOnce(url, { timeout = 20000, headers = {} } = {}) {
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
      res.on('data', (d) => chunks.push(Buffer.from(d)));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function fetchFollow(url, { timeout = 20000, maxRedirects = 4, headers = {} } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const res = await requestOnce(current, { timeout, headers });
    if (res.redirect) { current = res.redirect; continue; }
    return res;
  }
  throw new Error('too many redirects');
}

// 通过线上代理探测（对照 Vercel 出网）：/live-proxy.m3u8?url=...
async function probeViaProxy(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${VIA}/live-proxy.m3u8?url=${encodeURIComponent(rawUrl)}`, { signal: controller.signal });
    const text = await res.text();
    const ok = res.ok && text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
    return { ok, ms: Date.now() - started, text: ok ? text : '' };
  } catch {
    return { ok: false, ms: Date.now() - started, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

// 直连探测（在本机出网）
async function probeDirect(rawUrl) {
  const started = Date.now();
  try {
    const res = await fetchFollow(rawUrl, { timeout: TIMEOUT_MS, headers: { Range: 'bytes=0-65535' } });
    const text = (res.body || '').replace(/^\uFEFF/, '').trimStart();
    const ok = res.status >= 200 && res.status < 400 && text.startsWith('#EXTM3U');
    return { ok, ms: Date.now() - started, text: ok ? text : '' };
  } catch {
    return { ok: false, ms: Date.now() - started, text: '' };
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

function canon(name) {
  const n = name.replace(/[\uFEFF\s]+/g, '').normalize('NFKC');
  let m = n.match(/CCTV-?(\d+)(\+)?/i);
  if (m) return `CCTV-${m[1]}${m[2] ? '+' : ''}`;
  m = n.match(/CETV-?(\d+)/i);
  if (m) return `CETV${m[1]}`;
  if (/^CGTN/i.test(n)) return 'CGTN';
  return '';
}

// 频道名归一：去掉 [BD]/[Not 24/7] 前后缀与 (720p)/(1080p)/HD 等质量标记，用于同名合并
function keyOf(name) {
  return name
    .normalize('NFKC')
    .replace(/^\s*[[【][^\]】]*[\]】]\s*/, '')
    .replace(/\s*[[【(（][^\]】)）]*[\]】)）]\s*$/g, '')
    .replace(/\b(720p|1080p|1080i|576p|576i|480p|4K|8K|HD|SD|FHD|UHD|HEVC|H\.?26[45])\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// 分组：央视 / 卫视 / 地方 / 其他（用于抽样对比）
function groupOf(name) {
  const n = name.normalize('NFKC');
  if (/cctv|cgtn|cetv|央视|中央/i.test(n)) return '央视';
  if (/卫视/.test(n)) return '卫视';
  if (/[\u4e00-\u9fa5]{2,}/.test(n)) return '地方';
  return '其他';
}

// 地方台抽样排除明显非频道内容
const LOCAL_NOISE_RE = /(春晚|相声|小品|演唱会|电影|电视剧|纪录片|合集|精选|音乐|MV|广告|测试|年\d+月|第\d+季)/i;

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

function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : '-'; }

async function main() {
  console.log(`探测模式: ${VIA ? '经线上代理 ' + VIA : '本机直连'} | 并发 ${CONCURRENCY} | 超时 ${TIMEOUT_MS}ms\n`);
  console.log('拉取源清单…');
  const allRows = [];
  const sourceStat = [];
  for (const src of SOURCES) {
    const started = Date.now();
    try {
      let res;
      try {
        res = await fetchFollow(src, { timeout: 25000 });
      } catch (e) {
        const host = new URL(src).hostname;
        if (MIRRORS[host]) {
          const mirrored = src.replace(`https://${host}`, MIRRORS[host]).replace('/master/', '@master/');
          res = await fetchFollow(mirrored, { timeout: 25000 });
        } else throw e;
      }
      const rows = parseM3U(res.body || '');
      rows.forEach((r) => allRows.push({ ...r, src }));
      sourceStat.push({ src, rows: rows.length, ms: Date.now() - started });
      console.log(`  OK  ${src.split('/').slice(-2).join('/').padEnd(28)} ${String(rows.length).padStart(5)} 条  ${Date.now() - started}ms`);
    } catch (e) {
      sourceStat.push({ src, rows: 0, error: e.message });
      console.log(`  NO  ${src.split('/').slice(-2).join('/').padEnd(28)} ${e.message}`);
    }
  }

  // 按台名归一后合并线路（与线上逻辑一致：同名频道多线路）
  const byName = new Map();
  for (const row of allRows) {
    const key = keyOf(row.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, { name: key, group: groupOf(row.name), urls: [] });
    const ch = byName.get(key);
    if (!ch.urls.includes(row.url) && ch.urls.length < 5) ch.urls.push(row.url);
  }
  const channels = [...byName.values()];
  console.log(`\n合并后 ${channels.length} 个频道，开始探测（每台最多 5 条线路）…\n`);

  const groups = ['央视', '卫视', '地方'];
  const summary = {};
  const detail = {};

  for (const g of groups) {
    let list = channels.filter((c) => c.group === g);
    if (g === '央视') {
      // 只统计标准央视台（CCTV-N / CCTV-N+ / CETV N / CGTN），排除 CCTV+ 等衍生素材
      list = list.filter((c) => canon(c.name));
      list.sort((a, b) => canon(a.name).localeCompare(canon(b.name), 'en', { numeric: true }));
    } else if (g === '地方') {
      // 排除春晚/电影/综艺合集这类非地方台条目
      list = list.filter((c) => !LOCAL_NOISE_RE.test(c.name));
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    }
    const cap = SAMPLE > 0 ? SAMPLE : (g === '地方' ? 60 : 40);
    list = list.slice(0, cap);

    const results = await pool(list, CONCURRENCY, async (ch) => {
      let aliveUrl = '';
      let bestMs = 0;
      let aliveCount = 0;
      for (const url of ch.urls) {
        const r = await probe(url);
        if (r.ok) {
          aliveCount += 1;
          if (!aliveUrl) { aliveUrl = url; bestMs = r.ms; }
        }
      }
      return { name: ch.name, lines: ch.urls.length, aliveLines: aliveCount, ok: Boolean(aliveUrl), ms: bestMs, url: aliveUrl };
    });

    const okCount = results.filter((r) => r.ok).length;
    const lat = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    summary[g] = {
      sampled: results.length,
      playable: okCount,
      ratio: pct(okCount, results.length),
      p50ms: lat.length ? lat[Math.floor(lat.length / 2)] : null,
      baseline: BASELINE[g] || '-',
    };
    detail[g] = results;

    console.log(`【${g}】可播 ${okCount}/${results.length} = ${pct(okCount, results.length)}  （线上 Vercel 基线：${BASELINE[g] || '-'}）`);
    for (const r of results) {
      console.log(`   ${r.ok ? 'OK ' : 'NO '} ${r.name.padEnd(18)} ${r.aliveLines}/${r.lines} 条可用${r.ok ? `  ${r.ms}ms` : ''}`);
    }
    console.log('');
  }

  // HTTPS 分片占比：决定「浏览器直连 CDN」能省多少带宽
  console.log('统计 HTTPS 分片占比（抽样 20 条可用线路的清单）…');
  const aliveUrls = Object.values(detail).flat().filter((r) => r.ok).map((r) => r.url).slice(0, 20);
  let httpsSeg = 0;
  let httpSeg = 0;
  let manifestOk = 0;
  await pool(aliveUrls, 6, async (url) => {
    const r = await probe(url);
    if (!r.ok || !r.text) return;
    manifestOk += 1;
    const segs = r.text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    let base;
    try { base = new URL(url); } catch { return; }
    for (const seg of segs) {
      let abs;
      try { abs = new URL(seg, base).toString(); } catch { continue; }
      if (/\.(ts|m4s|mp4|aac)(\?|$)/i.test(abs)) {
        if (abs.startsWith('https:')) httpsSeg += 1; else httpSeg += 1;
      }
    }
  });
  const segTotal = httpsSeg + httpSeg;
  console.log(`  可读清单 ${manifestOk}/${aliveUrls.length} | 分片 HTTPS ${httpsSeg} / HTTP ${httpSeg}${segTotal ? `（HTTPS 占 ${pct(httpsSeg, segTotal)}）` : ''}\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: VIA ? `via ${VIA}` : 'direct',
    summary,
    httpsSegment: { https: httpsSeg, http: httpSeg, share: segTotal ? pct(httpsSeg, segTotal) : null },
    sources: sourceStat,
    detail,
  };
  const dest = `live-report${VIA ? '-via-proxy' : ''}.json`;
  fs.writeFileSync(dest, JSON.stringify(report, null, 2), 'utf8');

  console.log('=== 汇总 ===');
  for (const g of groups) {
    console.log(`  ${g.padEnd(3)} 可播 ${summary[g].playable}/${summary[g].sampled} (${summary[g].ratio})   线上基线 ${summary[g].baseline}`);
  }
  console.log(`\n报告已写入 ${dest}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
