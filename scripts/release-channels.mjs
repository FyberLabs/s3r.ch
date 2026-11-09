import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SHA = /^[0-9a-f]{40}$(?![\s\S])/;
const DIGEST = /^sha256:[0-9a-f]{64}$(?![\s\S])/;
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/;
export function validateManifest(m, repository, channel, revision, tag) {
  if (!m || Object.keys(m).sort().join() !== 'channel,digest,image,repository,revision,schema,tag,test_run_id' ||
      m.schema !== 1 || m.repository !== repository || m.channel !== channel || !SHA.test(m.revision) ||
      (revision && m.revision !== revision) || m.tag !== tag || !DIGEST.test(m.digest) ||
      m.image !== `ghcr.io/${repository.toLowerCase()}` || (typeof m.test_run_id !== 'string' || !/^[1-9]\d*$(?![\s\S])/.test(m.test_run_id)) ||
      (channel === 'test' ? tag !== `test-${m.revision}` : channel !== 'prod' || !STABLE.test(tag))) throw Error('Invalid release manifest');
  return m;
}
export function validTestRun(run, revision) {
  return run.head_sha === revision && run.head_branch === 'master' &&
    ['push', 'workflow_dispatch'].includes(run.event) && run.conclusion === 'success' &&
    run.path?.split('@')[0] === '.github/workflows/deploy.yml' && run.name === 'Deploy test';
}
export function signedByTestRun(results, m) {
  const prefix = `https://github.com/${m.repository}/actions/runs/${m.test_run_id}/attempts/`;
  return results.some(row => {
    const id = row.verificationResult?.statement?.predicate?.runDetails?.metadata?.invocationId;
    return typeof id === 'string' && id.startsWith(prefix) && /^[1-9][0-9]*$(?![\s\S])/.test(id.slice(prefix.length));
  });
}
function verifyTestManifest(m) {
  const dir = mkdtempSync(join(tmpdir(), 'tested-manifest-'));
  try {
    const path = join(dir, 'release-manifest.json');
    writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
    const verified = JSON.parse(run('gh', ['attestation', 'verify', path, '--repo', m.repository,
      '--signer-workflow', `${m.repository}/.github/workflows/deploy.yml`, '--source-ref', 'refs/heads/master',
      '--source-digest', m.revision, '--format', 'json']));
    if (!signedByTestRun(verified, m)) throw Error('Manifest was not signed by the successful test run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function publishedDigest(image, tag) {
  const path = image.slice('ghcr.io/'.length);
  const auth = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent('repository:' + path + ':pull')}`, { signal: AbortSignal.timeout(15000) });
  if (!auth.ok) throw Error('Public package access required');
  const { token } = await auth.json();
  if (typeof token !== 'string') throw Error('Registry authentication failed');
  const response = await fetch(`https://ghcr.io/v2/${path}/manifests/${tag}`, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' } });
  if (response.status === 404) return null;
  const digest = response.headers.get('docker-content-digest');
  if (!response.ok || !DIGEST.test(digest ?? '')) throw Error('Registry tag check failed');
  return digest;
}
export function compareTags(a, b) {
  if (!STABLE.test(a) || !STABLE.test(b)) throw Error('Stable release tags required');
  const x = a.slice(1).split('.').map(BigInt), y = b.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
const gh = path => JSON.parse(run('gh', ['api', path]));
function release(repository, tag) {
  try { return gh(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`); }
  catch (e) { if (/\(HTTP 404\)/.test(String(e.stderr))) return null; throw e; }
}
function download(repository, tag, channel, revision) {
  const r = release(repository, tag); if (!r) return null;
  if (r.draft || r.prerelease !== (channel === 'test')) throw Error('Wrong release channel');
  const assets = r.assets.filter(a => a.name === 'release-manifest.json');
  if (assets.length !== 1 || assets[0].size > 16384) throw Error('Missing or oversized release manifest');
  const dir = mkdtempSync(join(tmpdir(), 'release-manifest-'));
  try {
    const file = join(dir, 'release-manifest.json');
    run('gh', ['release', 'download', tag, '--repo', repository, '--pattern', 'release-manifest.json', '--output', file]);
    return validateManifest(JSON.parse(readFileSync(file, 'utf8')), repository, channel, revision, tag);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function registryDigest(reference) {
  const m = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}']));
  if (!DIGEST.test(m.digest)) throw Error('Registry did not return an immutable digest');
  return m.digest;
}
function alias(image, digest, tag) {
  run('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${image}:${tag}`, `${image}@${digest}`]);
  if (registryDigest(`${image}:${tag}`) !== digest) throw Error('Promotion changed artifact digest');
}
function publish(m) {
  const existing = release(m.repository, m.tag);
  if (existing) {
    const held = download(m.repository, m.tag, m.channel, m.revision);
    if (held.digest !== m.digest || held.test_run_id !== m.test_run_id) throw Error('Release already identifies another artifact');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'release-publish-'));
  try {
    const file = join(dir, 'release-manifest.json'), notes = join(dir, 'notes.md');
    writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
    writeFileSync(notes, `Image: \`${m.image}@${m.digest}\`\n\nRevision: \`${m.revision}\`\n\nTest run: https://github.com/${m.repository}/actions/runs/${m.test_run_id}\n\n## Config changes\nSee the merged configuration reference and companion infra changes.\n\n## Migration\nProduction is promoted from the tested digest; no rebuild.\n`);
    run('gh', ['release', 'create', m.tag, '--repo', m.repository, '--target', m.revision, '--title', m.tag, '--notes-file', notes,
      ...(m.channel === 'test' ? ['--prerelease'] : ['--latest=false']), file]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function output(key, value) {
  if (!process.env.GITHUB_OUTPUT) throw Error('GITHUB_OUTPUT required');
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
async function main() {
  const [action] = process.argv.slice(2), repository = process.env.GITHUB_REPOSITORY, revision = process.env.GITHUB_SHA;
  if (repository !== 'FyberLabs/s3r.ch' || !SHA.test(revision ?? '')) throw Error('Fixed repository and revision required');
  const image = `ghcr.io/${repository.toLowerCase()}`, tag = `test-${revision}`;
  if (action === 'candidate') {
    const held = download(repository, tag, 'test', revision);
    output('reuse', held ? 'true' : 'false'); output('digest', held?.digest ?? ''); return;
  }
  if (action === 'test') {
    if (process.env.GITHUB_REF !== 'refs/heads/master') throw Error('Only default-branch merges publish test releases');
    const held = download(repository, tag, 'test', revision);
    const digest = process.env.IMAGE_DIGEST;
    const m = validateManifest({ schema: 1, repository, channel: 'test', tag, revision, image, digest,
      test_run_id: held?.test_run_id ?? process.env.GITHUB_RUN_ID }, repository, 'test', revision, tag);
    if (registryDigest(`${image}@${digest}`) !== digest) throw Error('Candidate unavailable');
    if (registryDigest(`${image}:test`) !== digest) throw Error('Verified TEST channel changed');
    writeFileSync(join(process.env.RUNNER_TEMP, 'tested-release-manifest.json'), JSON.stringify(m, null, 2) + '\n');
    publish(m); return;
  }
  if (action !== 'promote' || !STABLE.test(process.env.GITHUB_REF_NAME ?? '') || process.env.GITHUB_REF !== `refs/tags/${process.env.GITHUB_REF_NAME}`) throw Error('Stable tag required');
  const stableTag = process.env.GITHUB_REF_NAME;
  // A tag can arrive while merge-to-test is still running. Wait for its exact
  // successful deployment manifest, never fall back to a newer :test alias.
  const deadline = Date.now() + 35 * 60 * 1000;
  let candidate;
  while (!(candidate = download(repository, tag, 'test', revision))) {
    if (Date.now() >= deadline) throw Error('Exact revision has no successful test release');
    await delay(15000);
  }
  // The test release is written after the deployment checks. Confirm the
  // publishing run itself completed successfully on the trusted branch.
  let evidence = gh(`repos/${repository}/actions/runs/${candidate.test_run_id}`);
  while (evidence.status !== 'completed' && Date.now() < deadline) {
    await delay(15000); evidence = gh(`repos/${repository}/actions/runs/${candidate.test_run_id}`);
  }
  if (!validTestRun(evidence, revision)) throw Error('Test deployment run is not successful');
  verifyTestManifest(candidate);
  const held = download(repository, stableTag, 'prod', revision);
  if (held && held.digest !== candidate.digest) throw Error('Stable release is immutable');
  const versionDigest = await publishedDigest(image, stableTag.slice(1));
  if (versionDigest && versionDigest !== candidate.digest) throw Error('Version image tag is immutable');
  alias(image, candidate.digest, stableTag.slice(1));
  publish({ ...candidate, channel: 'prod', tag: stableTag });
  const tags = run('gh', ['api', '--paginate', `repos/${repository}/releases?per_page=100`, '--jq', '.[] | select(.draft == false and .prerelease == false) | .tag_name']).trim().split('\n');
  const newer = tags.some(tag => STABLE.test(tag) && compareTags(tag, stableTag) > 0);
  if (!newer) {
    alias(image, candidate.digest, 'prod'); alias(image, candidate.digest, 'latest');
    run('gh', ['release', 'edit', stableTag, '--repo', repository, '--latest']);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Release channel operation failed: ${error.message}`); process.exitCode = 1; });
