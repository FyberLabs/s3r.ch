import { setTimeout as delay } from 'node:timers/promises';
const [origin, sha, priorRevision] = process.argv.slice(2);
const revisionPattern = /^[0-9a-f]{40}$/;
const peer = origin === 'https://test.s3r.ch/_peer';
if (!(peer || ['https://test.s3r.ch', 'https://s3r.ch'].includes(origin)) || !revisionPattern.test(sha ?? '') ||
    (priorRevision !== undefined && (origin === 'https://s3r.ch' || priorRevision === sha || !revisionPattern.test(priorRevision)))) {
  throw Error('Fixed deployment origin and revision required');
}
async function connectGun() {
  const socket = new WebSocket('wss://test.s3r.ch/gun');
  try {
    return await new Promise(resolve => {
      let opened = false;
      const timeout = setTimeout(() => finish(false), 5000);
      function finish(connected) {
        clearTimeout(timeout);
        resolve(connected);
      }
      socket.addEventListener('open', () => {
        opened = true;
        socket.close(1000);
      }, { once: true });
      socket.addEventListener('close', event => finish(opened && event.wasClean), { once: true });
      socket.addEventListener('error', () => finish(false), { once: true });
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
  }
}
async function gunReady(status) {
  if (origin !== 'https://test.s3r.ch') return status === 'ok';
  if (status !== 'ok' && status !== 'external') return false;
  return await connectGun() && await connectGun();
}
const windowMs = 5 * 60 * 1000;
let deadline = Date.now() + windowMs;
let sawTarget = false;
let lastProbeSawPrior = false;
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
    // A prior revision identified by the rollout can still be restarting its dependencies.
    lastProbeSawPrior = health.status === 'ok' && (priorRevision !== undefined
      ? version.revision === priorRevision
      : version.revision !== sha && revisionPattern.test(version.revision ?? '') && durableReady && configuredGun);
    observation = JSON.stringify({ revision: version.revision, health: health.status,
      identity: health.dependencies?.identity?.status, writable: health.dependencies?.identity?.writable,
      gun });
    if (version.revision === sha && health.status === 'ok' && durableReady && await gunReady(gun)) { ready = true; break; }
  } catch { /* Keep the last completed probe when either request fails. */ }
  await delay(3000);
}
if (ready) {
  console.log(`Verified ${origin} at ${sha}`);
} else {
  const message = `Deployment revision or durable dependency checks did not pass: ${observation} (candidateObserved=${sawTarget})`;
  if (origin === 'https://s3r.ch' || sawTarget || !lastProbeSawPrior) throw Error(message);
  // TEST deployment can refresh once when App Service is still serving the previous revision.
  console.error(message);
  process.exitCode = 3;
}
