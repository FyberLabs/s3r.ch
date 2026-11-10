import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest, compareTags, minorLine, promotionAliases, validTestRun, signedByTestRun, requireStableTag, releaseTargetArgs } from './release-channels.mjs';
const revision = 'a'.repeat(40), repository = 'FyberLabs/s3r.ch', tag = `test-${revision}`;
const candidate = { schema: 1, repository, channel: 'test', tag, revision, image: 'ghcr.io/fyberlabs/s3r.ch', digest: 'sha256:' + 'b'.repeat(64), test_run_id: '123' };
test('promotion is bound to the exact repository, tested revision, image and channel', () => {
  assert.deepEqual(validateManifest(candidate, repository, 'test', revision, tag), candidate);
  for (const changes of [{ channel: 'prod' }, { repository: 'other/repo' }, { image: 'ghcr.io/other/image' }, { revision: 'c'.repeat(40) }, { digest: 'latest' }, { test_run_id: '0' }, { extra: true }]) {
    assert.throws(() => validateManifest({ ...candidate, ...changes }, repository, 'test', revision, tag));
  }
  assert.doesNotThrow(() => validateManifest({ ...candidate, channel: 'prod', tag: 'v1.2.3' }, repository, 'prod', revision, 'v1.2.3'));
  assert.throws(() => validateManifest({ ...candidate, channel: 'prod', tag: 'v1.2.3-rc.1' }, repository, 'prod', revision, 'v1.2.3-rc.1'));
});
test('promoting vX.Y.Z also moves X.Y to that patch', () => {
  assert.equal(minorLine('v1.4.2'), '1.4');
  assert.equal(minorLine('v1.10.0'), '1.10');
  assert.deepEqual(promotionAliases('v1.4.2', ['v1.4.2']), ['1.4.2', '1.4', 'prod', 'latest']);
  assert.deepEqual(promotionAliases('v1.4.2', ['v1.4.2', 'v1.5.0']), ['1.4.2', '1.4']);
  assert.deepEqual(promotionAliases('v1.4.2', ['v1.4.2', 'v1.4.3']), ['1.4.2']);
  const promote = readFileSync(new URL('./release-channels.mjs', import.meta.url), 'utf8');
  const body = promote.slice(promote.indexOf("action !== 'promote'"));
  assert.match(body, /const aliases = promotionAliases\(stableTag, tags\)/);
  assert.match(body, /alias\(image, candidate\.digest, name\)/);
});
test('backports cannot replace a newer production alias', () => {
  assert.equal(compareTags('v2.0.0', 'v1.99.99'), 1);
  assert.equal(compareTags('v1.0.9', 'v1.0.10'), -1);
  assert.equal(compareTags('v1.0.0', 'v1.0.0'), 0);
  assert.throws(() => compareTags('test-main', 'v1.0.0'));
});
test('an unrelated green run or wrong branch is not test-deployment evidence', () => {
  const run = { head_sha: revision, head_branch: 'master', event: 'push', conclusion: 'success', path: '.github/workflows/deploy.yml', name: 'Deploy test' };
  assert.equal(validTestRun(run, revision), true);
  for (const change of [{ head_sha: 'c'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { conclusion: 'failure' }, { path: '.github/workflows/test.yml' }, { name: 'Deploy' }]) assert.equal(validTestRun({ ...run, ...change }, revision), false);
});

test('verified provenance must identify the exact successful test invocation', () => {
  const proof = run => [{ verificationResult: { statement: { predicate: { runDetails: { metadata: { invocationId: `https://github.com/FyberLabs/s3r.ch/actions/runs/${run}/attempts/1` } } } } } }];
  assert.equal(signedByTestRun(proof('123'), candidate), true);
  assert.equal(signedByTestRun(proof('124'), candidate), false);
  assert.equal(signedByTestRun([], candidate), false);
});

const stable = { ...candidate, channel: 'prod', tag: 'v1.2.3' };
test('stable publication uses only an existing tag while automatic TEST targets its candidate', () => {
  assert.deepEqual(releaseTargetArgs(stable), ['--verify-tag', '--latest=false']);
  assert.deepEqual(releaseTargetArgs(candidate), ['--target', revision, '--prerelease']);
});
test('stable tag must resolve remotely to the tested revision, including annotated tags', () => {
  assert.doesNotThrow(() => requireStableTag(stable, () => ({ object: { type: 'commit', sha: revision } })));
  const annotation = 'd'.repeat(40), calls = [];
  requireStableTag(stable, path => {
    calls.push(path);
    return { object: path.endsWith('/v1.2.3') ? { type: 'tag', sha: annotation } : { type: 'commit', sha: revision } };
  });
  assert.deepEqual(calls, [`repos/${repository}/git/ref/tags/v1.2.3`, `repos/${repository}/git/tags/${annotation}`]);
  for (const object of [{ type: 'commit', sha: 'c'.repeat(40) }, { type: 'tree', sha: revision }, null, { type: 'tag', sha: annotation }]) {
    assert.throws(() => requireStableTag(stable, () => ({ object })));
  }
  assert.throws(() => requireStableTag(stable, () => { throw Error('HTTP 404'); }), /HTTP 404/);
  assert.throws(() => requireStableTag(candidate, () => { throw Error('must not query'); }), /Stable manifest required/);
});
