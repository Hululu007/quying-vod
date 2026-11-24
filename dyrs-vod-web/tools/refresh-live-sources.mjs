#!/usr/bin/env node
// 直播精选清单自检：逐条探测 assets/*-live.m3u，把多次重试仍不可达的线路剔除，原地重写。
//
// 为什么不在 GitHub Actions / 海外机房跑：
//   运营商 CDN 与国内 IPTV 会拒绝海外出网 IP，在海外探测会把「国内用户可达」的线路误删。
//   建议在目标观众网络里的机器上定时运行（国内 Windows 任务计划、国内 VPS cron 均可）。
//
// 用法：
//   node tools/refresh-live-sources.mjs             # 探测并重写清单
//   node tools/refresh-live-sources.mjs --dry-run   # 只报告，不写文件
//   TIMEOUT=8000 RETRIES=2 CONCURRENCY=6 node tools/refresh-live-sources.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// 解析 M3U：保留头部注释，按 #EXTINF + URL 配对成条目
export function parseLivePlaylist(text) {
  const head = [];
  const entries = [];
  let pending = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (pending && line.startsWith('#')) { pending += `\n${line}`; continue; }
    if (/^#EXTINF:/i.test(line)) { pending = line; continue; }
    if (line.startsWith('#')) { if (!pending) head.push(line); continue; }
    if (!/^https?:\/\//i.test(line)) continue;
    if (!pending) continue;
    entries.push({ tag: pending, url: line, name: liveEntryName(pending) });
    pending = null;
  }
  return { head, entries };
}

export function liveEntryName(tag) {
  const line = String(tag || '').split('\n')[0];
  const comma = line.lastIndexOf(',');
  return (comma >= 0 ? line.slice(comma + 1) : '').trim();
}

export function serializeLivePlaylist({ head, entries }) {
  const lines = head.length ? [...head] : ['#EXTM3U'];
  for (const entry of entries) lines.push(entry.tag, entry.url);
  return `${lines.join('\n')}\n`;
}

async function probeOnce(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'User-Agent': UA, Accept: 'application/x-mpegURL,*/*' },
    });
    if (!res.ok) return false;
    const text = (await res.text()).slice(0, 1024).replace(/^\uFEFF/, '').trimStart();
    return text.startsWith('#EXTM3U');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeWithRetry(url, { timeout = 6000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (await probeOnce(url, timeout)) return true;
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return false;
}

async function probeAll(entries, { timeout, retries, concurrency }) {
  const alive = new Array(entries.length).fill(false);
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const at = cursor;
      cursor += 1;
      alive[at] = await probeWithRetry(entries[at].url, { timeout, retries });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker));
  return alive;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const timeout = Math.max(1000, Number(process.env.TIMEOUT) || 6000);
  const retries = Math.max(0, Number(process.env.RETRIES) || 2);
  const concurrency = Math.max(1, Number(process.env.CONCURRENCY) || 6);
  const files = readdirSync(ASSETS_DIR).filter((name) => /-live\.m3u$/i.test(name)).sort();
  if (!files.length) {
    console.log('assets/ 下没有 *-live.m3u 清单，跳过');
    return;
  }
  let totalDropped = 0;
  for (const file of files) {
    const full = path.join(ASSETS_DIR, file);
    const playlist = parseLivePlaylist(await readFile(full, 'utf8'));
    if (!playlist.entries.length) {
      console.log(`\n[${file}] 无有效条目，跳过`);
      continue;
    }
    console.log(`\n[${file}] 探测 ${playlist.entries.length} 条线路…`);
    const alive = await probeAll(playlist.entries, { timeout, retries, concurrency });
    const kept = playlist.entries.filter((_, i) => alive[i]);
    const dropped = playlist.entries.filter((_, i) => !alive[i]);
    totalDropped += dropped.length;
    console.log(`  可达 ${kept.length} / ${playlist.entries.length}${dropped.length ? `，剔除 ${dropped.length} 条` : ''}`);
    for (const entry of dropped) console.log(`  - 剔除 ${entry.name || '(未命名)'} ${entry.url}`);
    if (!dropped.length) continue;
    if (dryRun) { console.log('  --dry-run：不写文件'); continue; }
    await writeFile(full, serializeLivePlaylist({ head: playlist.head, entries: kept }), 'utf8');
    console.log('  已重写清单');
  }
  console.log(`\n完成：共剔除 ${totalDropped} 条不可达线路${dryRun ? '（dry-run，未写入）' : ''}`);
  if (totalDropped) console.log('提示：提交前建议在浏览器里抽查 2-3 个频道，确认不是本地网络抖动导致误删。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('刷新失败：', error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
