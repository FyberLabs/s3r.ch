import { setTimeout as delay } from 'node:timers/promises';
const [origin, sha] = process.argv.slice(2);
const peer = origin === 'https://test.s3r.ch/_peer';
if (!(peer || ['https://test.s3r.ch', 'https://s3r.ch'].includes(origin)) || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw Error('Fixed deployment origin and revision required');
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
const windowMs = 5 * 60 * 1000;
let deadline = Date.now() + windowMs;
let sawTarget = false;
let staleServing = false;
let observation = 'No successful version and health responses';
let ready = false;
while (Date.now() < deadline) {
  try {
    const [version, health] = await Promise.all(['/api/version', '/api/health'].map(async path => {
      const r = await fetch(origin + path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (r.status !== 200) throw Error('Not ready'); return r.json();
    }));
    if (!sawTarget && version.revision === sha) {
      sawTarget = true;
      // Allow TEST dependencies to initialize after Azure switches to the new container.
      if (origin === 'https://test.s3r.ch') deadline = Date.now() + windowMs;
    }
    const durableReady = peer || (health.dependencies?.identity?.writable === true && health.dependencies?.identity?.status === 'ok');
    const gun = health.dependencies?.gun?.status;
    const configuredGun = gun === 'ok' || (origin === 'https://test.s3r.ch' && gun === 'external');
    staleServing = !sawTarget && /^[0-9a-f]{40}$/.test(version.revision ?? '') &&
      health.status === 'ok' && durableReady && configuredGun;
    observation = JSON.stringify({ revision: version.revision, health: health.status,
      identity: health.dependencies?.identity?.status, writable: health.dependencies?.identity?.writable,
      gun });
    if (version.revision === sha && health.status === 'ok' && durableReady && await gunReady(gun)) { ready = true; break; }
  } catch { staleServing = false; }
  await delay(3000);
}
if (ready) {
  console.log(`Verified ${origin} at ${sha}`);
} else {
  const message = 'Deployment revision or durable dependency checks did not pass: ' + observation;
  if (origin === 'https://s3r.ch' || !staleServing) throw Error(message);
  // TEST deployment can refresh once when a healthy previous revision is still serving.
  console.error(message);
  process.exitCode = 3;
}
