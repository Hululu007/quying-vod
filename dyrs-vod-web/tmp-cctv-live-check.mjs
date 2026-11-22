// 生产环境实测：央视分组每台是否至少一条线路可用（与前端探活同路径 /live-proxy.m3u8）
import https from 'node:https';

const HOST = 'https://quying.de5.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const getJson = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': UA } }, (r) => {
    const c = []; r.on('data', (d) => c.push(Buffer.from(d))); r.on('end', () => res(JSON.parse(Buffer.concat(c).toString('utf8'))));
  }).on('error', rej);
});

async function probe(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${HOST}/live-proxy.m3u8?url=${encodeURIComponent(rawUrl)}`, { signal: controller.signal });
    if (!res.ok) return false;
    const text = await res.text();
    return text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
  } catch { return false; } finally { clearTimeout(timer); }
}

const data = await getJson(`${HOST}/api/live/channels?group=${encodeURIComponent('央视')}&size=25&t=${Date.now()}`);
const list = data.list || [];
let cursor = 0; const out = [];
const worker = async () => {
  while (cursor < list.length) {
    const ch = list[cursor]; cursor += 1;
    const rs = await Promise.all(ch.lines.slice(0, 5).map((l) => probe(l.url)));
    out.push({ name: ch.name, alive: rs.filter(Boolean).length, total: rs.length });
  }
};
await Promise.all([worker(), worker(), worker(), worker()]);
out.sort((a, b) => a.alive - b.alive);
for (const o of out) console.log(`${o.alive > 0 ? 'OK ' : 'NO '} ${o.name.padEnd(14)} ${o.alive}/${o.total} 条可用`);
const okCount = out.filter((o) => o.alive > 0).length;
console.log(`\n央视可播: ${okCount}/${out.length} = ${Math.round(okCount / out.length * 100)}%`);
