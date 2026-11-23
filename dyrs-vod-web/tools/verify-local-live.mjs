#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const assetsDir = path.join(process.cwd(), 'assets');
const files = fs.readdirSync(assetsDir).filter((f) => /\.m3u$/i.test(f));

console.log('=== assets/*.m3u 文件识别 ===');
for (const f of files) {
  const full = path.join(assetsDir, f);
  const text = fs.readFileSync(full, 'utf8');
  const always = /-live\.m3u$/i.test(f);
  const count = (text.match(/^#EXTINF:/gm) || []).length;
  console.log(`  ${f.padEnd(30)} always=${always}  频道数=${count}`);
}

// --- 复制 live.mjs 的 cleanName / nameKey 逻辑 ---
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

function nameKey(value) {
  const raw = cleanName(value).toLowerCase();
  const stripped = raw.replace(/[\u4e00-\u9fa5]+/g, '').trim();
  const cctvMatch = stripped.match(/(cctv|cetv)\s*[-]?\s*(\d+)\s*(?:\+|plus)?/);
  if (cctvMatch) {
    const plus = /\+|plus/i.test(raw) ? '+' : '';
    return `${cctvMatch[1]}${cctvMatch[2]}${plus}`;
  }
  if (/^cgtn/.test(raw)) return 'cgtn';
  if (/^btv\b|brtv|北京卫视/.test(raw)) return '北京卫视';
  const weishiMatch = raw.match(/([\u4e00-\u9fa5]{2,8}卫视)/);
  if (weishiMatch) return weishiMatch[1];
  if (/东方卫视|dragon\s*tv/i.test(raw)) return '东方卫视';
  return raw.replace(/[\s\-_–—·•.,!?()（）\[\]【】]+/g, '').replace(/\d+p?$/, '');
}

function parseM3U(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows = [];
  let pendingName = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      pendingName = line.split(',').pop().trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pendingName && /^https?:/i.test(line)) {
      rows.push({ name: pendingName, url: line, key: nameKey(pendingName) });
      pendingName = '';
    }
  }
  return rows;
}

console.log('\n=== weishi-live.m3u 详情 ===');
const weishi = parseM3U(fs.readFileSync(path.join(assetsDir, 'weishi-live.m3u'), 'utf8'));
const byKeyW = new Map();
for (const e of weishi) {
  if (!byKeyW.has(e.key)) byKeyW.set(e.key, []);
  byKeyW.get(e.key).push(e);
}
for (const [key, list] of byKeyW) {
  const names = [...new Set(list.map((e) => e.name))];
  console.log(`  ${key.padEnd(14)} × ${list.length}  台名=[${names.join(', ')}]`);
}

console.log('\n=== defang-live.m3u 详情 ===');
const defang = parseM3U(fs.readFileSync(path.join(assetsDir, 'defang-live.m3u'), 'utf8'));
const byKeyD = new Map();
for (const e of defang) {
  if (!byKeyD.has(e.key)) byKeyD.set(e.key, []);
  byKeyD.get(e.key).push(e);
}
for (const [key, list] of byKeyD) {
  const names = [...new Set(list.map((e) => e.name))];
  console.log(`  ${key.padEnd(16)} × ${list.length}  台名=[${names.join(', ')}]`);
}

// 与 iptv-org cn.m3u 的同名频道做 key 对齐抽查
console.log('\n=== 台名 key 对齐抽查 ===');
const probe = ['广东卫视', '浙江卫视', '东方卫视', '北京卫视', '四川科教', '江津新闻综合'];
for (const name of probe) {
  console.log(`  "${name}" → key="${nameKey(name)}"`);
}

// 汇总
console.log('\n=== 汇总 ===');
console.log(`  卫视: ${weishi.length} 条线路 / ${byKeyW.size} 个唯一台（always 优先）`);
console.log(`  地方: ${defang.length} 条线路 / ${byKeyD.size} 个唯一台（always 优先）`);
console.log('  ✓ live.mjs 会在远端源之前注入这两份清单，线路排 lines[0] 优先播放');
