import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const INFRA_REPOSITORY = 'FyberLabs/infra';
export const FIND_LIMIT_MS = 120_000;
export const WATCH_LIMIT_MS = 40 * 60 * 1000;
export const INTERVAL_MS = 5_000;
const SHA = /^[0-9a-f]{40}$/;
const RUN = /^[1-9]\d{0,18}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKFLOWS = {
  test: 's3rch-test-static.yml',
  refresh: 's3rch-test-refresh.yml',
  release: 's3rch-prod-static.yml',
};

export function requestFor(kind, env, nonce = randomUUID()) {
  const runId = env.DISPATCH_RUN_ID ?? '';
  if (!RUN.test(runId)) throw Error('Dispatch run id is required');
  if (!NONCE.test(nonce)) throw Error('Dispatch nonce is required');
  if (kind === 'test') {
    const revision = env.DISPATCH_REVISION ?? '';
    if (!SHA.test(revision)) throw Error('Deployed revision is required');
    const title = `static-test-${runId}-${nonce}`;
    return { workflow: WORKFLOWS.test, title, inputs: { revision, source_run_id: runId, dispatch_title: title } };
  }
  if (kind === 'refresh') {
    const revision = env.DISPATCH_REVISION ?? '';
    const attempt = env.DISPATCH_RUN_ATTEMPT ?? '';
    const digest = env.DISPATCH_CHANNEL_DIGEST ?? '';
    if (!SHA.test(revision) || !RUN.test(attempt) || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw Error('TEST refresh requires an exact attempt, revision and channel digest');
    }
    const title = `test-refresh-${runId}-${nonce}`;
    return {
      workflow: WORKFLOWS.refresh,
      title,
      inputs: {
        source_run_id: runId, source_run_attempt: attempt, source_revision: revision,
        channel_digest: digest, dispatch_title: title,
      },
    };
  }
  if (kind === 'release') {
    const tag = env.DISPATCH_TAG ?? '';
    if (!TAG.test(tag)) throw Error('Stable release tag is required');
    const title = `static-release-${tag}-${runId}-${nonce}`;
    return { workflow: WORKFLOWS.release, title, inputs: { tag, source_run_id: runId, dispatch_title: title } };
  }
  if (kind === 'reconcile') {
    const title = `static-reconcile-${runId}-${nonce}`;
    return { workflow: WORKFLOWS.test, title, inputs: { revision: '', source_run_id: '', dispatch_title: title } };
  }
  throw Error('Unknown static publish');
}

function github(token, fetchImpl) {
  return async (path, options = {}) => {
    let response;
    try {
      response = await fetchImpl('https://api.github.com' + path, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 's3rch-static-dispatch',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw Error(`GitHub request failed for ${path}`);
    }
    const text = await response.text();
    if (!response.ok) throw Error(`GitHub ${response.status} for ${path}`);
    return text ? JSON.parse(text) : {};
  };
}

export async function dispatchAndWatch(kind, env, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), now = Date.now) {
  if (!env.GH_TOKEN) throw Error('Infra dispatch token is required');
  const request = requestFor(kind, env);
  const call = github(env.GH_TOKEN, fetchImpl);
  await call(`/repos/${INFRA_REPOSITORY}/actions/workflows/${request.workflow}/dispatches`, {
    method: 'POST', body: { ref: 'main', inputs: request.inputs },
  });
  const started = now();
  let found;
  while (!found) {
    if (now() - started > FIND_LIMIT_MS) throw Error(`Infra static publish did not start within ${FIND_LIMIT_MS / 1000}s`);
    const page = await call(`/repos/${INFRA_REPOSITORY}/actions/workflows/${request.workflow}/runs?event=workflow_dispatch&per_page=20`);
    found = (page.workflow_runs ?? []).find((run) => {
      if (run.display_title !== request.title && run.name !== request.title) return false;
      return !run.created_at || Date.parse(run.created_at) >= started - 15_000;
    });
    if (!found) await sleep(INTERVAL_MS);
  }
  const watchLimit = kind === 'refresh' ? 12 * 60 * 1000 : WATCH_LIMIT_MS;
  const watchStarted = now();
  let current = found;
  while (current.status !== 'completed') {
    if (now() - watchStarted > WATCH_LIMIT_MS) {
      throw Error(`Infra static publish was still ${current.status} within ${WATCH_LIMIT_MS / 1000}s`);
    }
    await sleep(INTERVAL_MS);
    current = await call(`/repos/${INFRA_REPOSITORY}/actions/runs/${current.id}`);
  }
  if (current.conclusion !== 'success') {
    throw Error(`Infra static publish failed (${current.conclusion}) for ${current.html_url}`);
  }
  return current.id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  dispatchAndWatch(process.argv[2], process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
