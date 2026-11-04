import { setTimeout as delay } from 'node:timers/promises';
const [origin, sha] = process.argv.slice(2);
if (!['https://test.s3r.ch', 'https://s3r.ch'].includes(origin) || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw Error('Fixed deployment origin and revision required');
const deadline = Date.now() + 5 * 60 * 1000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const [version, health] = await Promise.all(['/api/version', '/api/health'].map(async path => {
      const r = await fetch(origin + path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Error('Not ready'); return r.json();
    }));
    if (version.revision === sha && health.dependencies?.gun?.status === 'ok' && health.dependencies?.identity?.status === 'ok') { ready = true; break; }
  } catch { /* Deployment or dependency startup is not ready yet. */ }
  await delay(3000);
}
if (!ready) throw Error('Deployment revision or durable dependency checks did not pass');
console.log(`Verified ${origin} at ${sha}`);
