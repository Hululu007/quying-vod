// 用与前端完全相同的探活方式（/live-proxy.m3u8）抽查各分组首线路，确认失效比例
import https from 'node:https';

const HOST = 'https://quying.de5.net';
const get = (u) => new Promise((res, rej) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
  const c = []; r.on('data', (d) => c.push(Buffer.from(d))); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') }));
}).on('error', rej));

async function probeViaProxy(rawUrl) {
  const u = `${HOST}/live-proxy.m3u8?url=${encodeURIComponent(rawUrl)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(u, { signal: controller.signal }).catch(() => null);
    if (!res || !res.ok) return false;
    const text = await res.text();
    return text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
  } catch { return false; } finally { clearTimeout(timer); }
}

for (const group of ['央视', '地方']) {
  const data = JSON.parse((await get(`${HOST}/api/live/channels?group=${encodeURIComponent(group)}&size=20&t=${Date.now()}`)).body);
  const list = data.list || [];
  let cursor = 0; const results = [];
  const worker = async () => {
    while (cursor < list.length) {
      const ch = list[cursor]; cursor += 1;
      const ok = await probeViaProxy(ch.lines[0].url);
      results.push({ name: ch.name, src: ch.lines[0].source, ok });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const dead = results.filter((r) => !r.ok);
  console.log(`\n${group}: ${results.length - dead.length}/${results.length} 首线路可达`);
  if (dead.length) console.log('  失效:', dead.map((d) => `${d.name}(${d.src})`).join(', '));
  else console.log('  （该分组抽样内首线路全部可达，因此列表不会出现失效标记）');
}
