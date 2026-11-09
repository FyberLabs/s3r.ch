import { setTimeout as delay } from 'node:timers/promises';
const [origin, sha] = process.argv.slice(2);
if (!['https://test.s3r.ch', 'https://s3r.ch'].includes(origin) || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw Error('Fixed deployment origin and revision required');
async function gunReady(status) {
  if (status === 'ok') return true;
  if (origin !== 'https://test.s3r.ch' || status !== 'external') return false;
  const socket = new WebSocket('wss://test.s3r.ch/gun');
  try {
    return await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 5000);
      function finish(connected) {
        clearTimeout(timeout);
        resolve(connected);
      }
      socket.addEventListener('open', () => finish(true), { once: true });
      socket.addEventListener('error', () => finish(false), { once: true });
    });
  } finally {
    socket.close();
  }
}
const deadline = Date.now() + 5 * 60 * 1000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const [version, health] = await Promise.all(['/api/version', '/api/health'].map(async path => {
      const r = await fetch(origin + path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (r.status !== 200) throw Error('Not ready'); return r.json();
    }));
    if (version.revision === sha && health.status === 'ok' && health.dependencies?.identity?.writable === true && health.dependencies?.identity?.status === 'ok' && await gunReady(health.dependencies?.gun?.status)) { ready = true; break; }
  } catch { /* Deployment or dependency startup is not ready yet. */ }
  await delay(3000);
}
if (!ready) throw Error('Deployment revision or durable dependency checks did not pass');
console.log(`Verified ${origin} at ${sha}`);
