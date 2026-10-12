// Identity storage health, shared by the preload and the route handlers.
//
// Account links live in one private blob. If that blob cannot be reached at
// startup, the site still serves the feed, the forum and /gun. Only account
// linking and other identity writes are refused until storage comes back.
// A background monitor retries the check and flips the state when it passes.
const path = require("node:path");
const fs = require("node:fs");

const STATE_KEY = Symbol.for("s3rch.identityHealth");
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60000;

function initialStatus(env = process.env) {
  return env.NODE_ENV === "production" ? "checking" : "ok";
}

function state() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      status: initialStatus(),
      reason: null,
      checkedAt: null,
      attempts: 0,
      nextRetryAt: null,
      generation: 0,
    };
  }
  return globalThis[STATE_KEY];
}

/** status: "ok" | "checking" | "unavailable" | "invalid" */
function setIdentityHealth(status, reason = null, now = Date.now()) {
  const current = state();
  if (status === "ok" && current.status !== "ok") current.generation += 1;
  current.status = status;
  current.reason = status === "ok" ? null : reason;
  current.checkedAt = new Date(now).toISOString();
  return current;
}

function identityHealth() {
  const { status, reason, checkedAt, attempts, nextRetryAt } = state();
  return { status, reason, checkedAt, attempts, nextRetryAt };
}

function identityGeneration() {
  return state().generation;
}

/** Writes are allowed outside production, and in production only after a passing check. */
function identityWritable(env = process.env) {
  if (env.NODE_ENV !== "production") return true;
  return state().status === "ok";
}

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
  const { Worker } = require("node:worker_threads");
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
    const current = state();
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

function resetIdentityHealthForTests(status = "ok") {
  delete globalThis[STATE_KEY];
  state().status = status;
}

module.exports = {
  RETRY_MIN_MS,
  RETRY_MAX_MS,
  setIdentityHealth,
  identityHealth,
  identityGeneration,
  identityWritable,
  classifyFailure,
  retryDelay,
  probeInWorker,
  startIdentityMonitor,
  resetIdentityHealthForTests,
};
