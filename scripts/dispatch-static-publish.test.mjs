import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIND_LIMIT_MS, INTERVAL_MS, INFRA_REPOSITORY, WATCH_LIMIT_MS,
  dispatchAndWatch, requestFor,
} from './dispatch-static-publish.mjs';

const revision = 'a'.repeat(40);
const token = 'ghs_static_dispatch_secret_value';
const env = { GH_TOKEN: token, DISPATCH_REVISION: revision, DISPATCH_RUN_ID: '4242', DISPATCH_TAG: 'v1.2.3' };

function workflows(text) {
  return {
    deploy: text.includes('name: Deploy test'),
    release: text.includes('name: Release'),
  };
}

test('deploy and release dispatches stay on the infra static workflows', () => {
  const testRequest = requestFor('test', env);
  const releaseRequest = requestFor('release', env);
  const reconcileRequest = requestFor('reconcile', env);
  assert.equal(testRequest.workflow, 's3rch-test-static.yml');
  assert.equal(releaseRequest.workflow, 's3rch-prod-static.yml');
  assert.equal(reconcileRequest.workflow, 's3rch-test-static.yml');
  assert.equal(testRequest.inputs.revision, revision);
  assert.equal(testRequest.inputs.source_run_id, '4242');
  assert.equal(releaseRequest.inputs.tag, 'v1.2.3');
  assert.equal(reconcileRequest.inputs.revision, '');
  assert.equal(reconcileRequest.inputs.source_run_id, '');
  assert.equal(testRequest.inputs.dispatch_title, testRequest.title);
  assert.notEqual(testRequest.title, requestFor('test', env).title);
  assert.match(testRequest.title, /^static-test-4242-[0-9a-f-]{36}$/);
  assert.match(releaseRequest.title, /^static-release-v1\.2\.3-4242-[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(testRequest).includes(token), false);
  for (const bad of [{ ...env, DISPATCH_REVISION: 'main' }, { ...env, DISPATCH_RUN_ID: '0' }, { ...env, DISPATCH_TAG: 'latest' }]) {
    assert.throws(() => requestFor(bad.DISPATCH_REVISION === 'main' ? 'test' : bad.DISPATCH_TAG === 'latest' ? 'release' : 'test', bad));
  }
  assert.throws(() => requestFor('release', { ...env, DISPATCH_TAG: 'v1.2' }));
  assert.throws(() => requestFor('other', env));
});

test('a failed or missing infra run fails within the wait and omits the token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.equal(JSON.stringify(options.body ?? '').includes(token), false);
    if (url.endsWith('/dispatches')) return { ok: true, status: 204, text: async () => '' };
    if (url.includes('/runs?')) return { ok: true, status: 200, text: async () => '' };
    throw Error(token);
  };
  let now = 0;
  await assert.rejects(
    dispatchAndWatch('test', env, fetchImpl, async () => { now = FIND_LIMIT_MS + 1; }, () => now),
    (error) => {
      assert.match(error.message, new RegExp(`did not start within ${FIND_LIMIT_MS / 1000}s`));
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
  assert.equal(calls[0].url, `https://api.github.com/repos/${INFRA_REPOSITORY}/actions/workflows/s3rch-test-static.yml/dispatches`);
  assert.equal(JSON.parse(calls[0].options.body).ref, 'main');

  let dispatched = '';
  const failing = async (url, options) => {
    if (url.endsWith('/dispatches')) {
      dispatched = JSON.parse(options.body).inputs.dispatch_title;
      return { ok: true, status: 204, text: async () => '' };
    }
    if (url.includes('/runs?')) {
      const previous = { id: 6, display_title: 'static-release-v1.2.3-4242-11111111-1111-4111-8111-111111111111', status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), html_url: 'https://github.com/FyberLabs/infra/actions/runs/6' };
      const current = { id: 7, display_title: dispatched, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/FyberLabs/infra/actions/runs/7' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ workflow_runs: [previous, current] }) };
    }
    throw Error(token);
  };
  await assert.rejects(
    dispatchAndWatch('release', env, failing, async () => {}, () => 0),
    /Infra static publish failed \(failure\) for https:\/\/github.com\/FyberLabs\/infra\/actions\/runs\/7/,
  );
});

test('an unfinished infra run fails at the watch bound', async () => {
  let now = 0;
  let dispatched = '';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/dispatches')) {
      dispatched = JSON.parse(options.body).inputs.dispatch_title;
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 8, workflow_runs: [{ id: 8, display_title: dispatched, status: 'in_progress' }], status: 'in_progress', conclusion: null }) };
  };
  await assert.rejects(
    dispatchAndWatch('reconcile', env, fetchImpl, async () => { now = WATCH_LIMIT_MS + INTERVAL_MS; }, () => now),
    new RegExp(`still in_progress within ${WATCH_LIMIT_MS / 1000}s`),
  );
});

test('success waits until the infra run completes', async () => {
  let polls = 0;
  let dispatched = '';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/dispatches')) {
      dispatched = JSON.parse(options.body).inputs.dispatch_title;
      return { ok: true, status: 204, text: async () => '' };
    }
    polls += 1;
    const done = polls > 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 9, status: done ? 'completed' : 'in_progress', conclusion: done ? 'success' : null, html_url: 'https://example.invalid/9', workflow_runs: [{ id: 9, display_title: dispatched, status: done ? 'completed' : 'in_progress', conclusion: done ? 'success' : null }] }) };
  };
  assert.equal(await dispatchAndWatch('test', env, fetchImpl, async () => {}, () => 0), 9);
});

test('workflows mint an infra-only Actions token and dispatch both surfaces for a tag', () => {
  const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.equal(workflows(deploy).deploy, true);
  for (const text of [deploy, release]) {
    assert.match(text, /actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/);
    assert.match(text, /repositories: infra\r?\n\s+permission-actions: write/);
    assert.match(text, /vars\.S3RCH_STATIC_DISPATCH_APP_ID/);
    assert.match(text, /secrets\.S3RCH_STATIC_DISPATCH_APP_PRIVATE_KEY/);
    assert.equal(text.includes('BEGIN OPENSSH'), false);
    assert.equal(text.includes('ghp_'), false);
  }
  assert.match(deploy, /node scripts\/dispatch-static-publish\.mjs test/);
  assert.match(release, /node scripts\/dispatch-static-publish\.mjs release/);
  assert.match(release, /node scripts\/dispatch-static-publish\.mjs reconcile/);
  assert.match(deploy, /needs: deploy/);
  const promote = release.indexOf('release-channels.mjs promote');
  const production = release.indexOf('dispatch-static-publish.mjs release');
  const reconcile = release.indexOf('dispatch-static-publish.mjs reconcile');
  assert.ok(promote < production && production < reconcile);
  assert.ok(release.indexOf('id: static-dispatch') < production);
  assert.ok(production < release.indexOf('id: static-reconcile') && release.indexOf('id: static-reconcile') < reconcile);
  assert.match(release.slice(reconcile - 400, reconcile), /steps\.static-reconcile\.outputs\.token/);
});


test('TEST release credentials are repository scoped and isolated from deployment and static dispatch', () => {
  const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = deploy.indexOf('      - name: Mint repository-scoped TEST publication token');
  const end = deploy.indexOf('      - name: Attest the verified test deployment manifest', start);
  assert.ok(start > deploy.indexOf('run: bash scripts/deploy-test.sh'));
  assert.ok(end > start);
  const publisher = deploy.slice(start, end);
  assert.match(publisher, /repositories: s3r\.ch\n/);
  assert.match(publisher, /owner: FyberLabs\n/);
  assert.match(publisher, /permission-contents: write\n/);
  assert.match(publisher, /permission-workflows: write\n/);
  assert.match(publisher, /vars\.S3RCH_TEST_PUBLICATION_APP_ID/);
  assert.match(publisher, /secrets\.S3RCH_TEST_PUBLICATION_APP_PRIVATE_KEY/);
  assert.match(publisher, /GH_TOKEN: \$\{\{ steps\.test-publication\.outputs\.token \}\}/);
  assert.equal(publisher.includes('STATIC_DISPATCH'), false);
  assert.equal(publisher.includes('skip-token-revoke'), false);
  const outside = deploy.slice(0, start) + deploy.slice(end);
  assert.equal(outside.includes('test-publication.outputs.token'), false);
  assert.equal(outside.includes('TEST_PUBLICATION_APP_PRIVATE_KEY'), false);
});
