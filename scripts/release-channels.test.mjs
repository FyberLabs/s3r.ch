import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, compareTags, validTestRun } from './release-channels.mjs';
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
