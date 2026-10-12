// Background identity storage check, started by gun-preload.cjs.
// It never throws and never exits the process. See identity-health.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { setIdentityHealth, identityState } = require("./identity-health.cjs");

const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;
// Worker start plus a reachability check, a read and possibly a create.
const PROBE_TIMEOUT_MS = require("./identity-blob.cjs").workerStartTimeoutMs() + 90000;

function classifyFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/identity store is invalid/.test(message)) return { status: "invalid", reason: message };
  if (/configure S3RCH_IDENTITY_BLOB_ACCOUNT/.test(message)) return { status: "unavailable", reason: message };
  return { status: "unavailable", reason: message || "s3r.ch: identity blob storage is unreachable" };
}

function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1));
}

function probeWorkerFile() {
  const candidates = [
    path.join(__dirname, "identity-probe-worker.cjs"),
    path.join(process.cwd(), "identity-probe-worker.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

/** Runs the blocking storage check on a worker thread so the event loop keeps serving. */
function probeInWorker(timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(probeWorkerFile());
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, message: "s3r.ch: identity blob storage is unreachable" }),
      timeoutMs,
    );
    if (typeof timer.unref === "function") timer.unref();
    worker.once("message", (message) => finish(message && typeof message === "object" ? message : { ok: false }));
    worker.once("error", (error) => finish({ ok: false, message: error && error.message }));
    worker.once("exit", () => finish({ ok: false, message: "s3r.ch: identity blob storage is unreachable" }));
  });
}

/**
 * Check identity storage now and keep retrying with backoff until it passes.
 * Never throws and never exits the process. Returns a handle with stop().
 */
function startIdentityMonitor(options = {}) {
  const env = options.env || process.env;
  const probe = options.probe || probeInWorker;
  const log = options.log || console;
  const schedule = options.schedule || ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  });
  const cancel = options.cancel || clearTimeout;
  const now = options.now || Date.now;
  let stopped = false;
  let timer = null;

  if (env.NODE_ENV !== "production") {
    setIdentityHealth("ok", null, now());
    return { stop() {}, done: Promise.resolve() };
  }

  setIdentityHealth("checking", null, now());

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  async function attempt() {
    if (stopped) return;
    const current = identityState();
    current.attempts += 1;
    let result;
    try {
      result = await probe();
    } catch (error) {
      result = { ok: false, message: error && error.message };
    }
    if (stopped) return;
    if (result && result.ok) {
      const wasDown = current.status !== "ok" && current.attempts > 1;
      setIdentityHealth("ok", null, now());
      current.nextRetryAt = null;
      if (wasDown) log.log("[s3r.ch] identity storage is reachable again; account linking is enabled");
      resolveDone();
      return;
    }
    const failure = classifyFailure(result && result.message);
    setIdentityHealth(failure.status, failure.reason, now());
    const delay = retryDelay(current.attempts);
    current.nextRetryAt = new Date(now() + delay).toISOString();
    log.error(
      `[s3r.ch] ${failure.reason}. Serving without account linking; retrying in ${Math.round(delay / 1000)}s`,
    );
    timer = schedule(attempt, delay);
  }

  attempt();
  return {
    stop() {
      stopped = true;
      if (timer) cancel(timer);
      resolveDone();
    },
    done,
  };
}

module.exports = {
  RETRY_MIN_MS,
  RETRY_MAX_MS,
  classifyFailure,
  retryDelay,
  probeInWorker,
  startIdentityMonitor,
};
