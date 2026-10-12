// Identity storage health, shared by the preload and the route handlers.
//
// Account links live in one private blob. If that blob cannot be reached at
// startup, the site still serves the feed, the forum and /gun. Only account
// linking and other identity writes are refused until storage comes back.
// identity-monitor.cjs retries the check and flips the state when it passes.
// This file holds state only, so route handlers can import it cheaply.
const STATE_KEY = Symbol.for("s3rch.identityHealth");

function state() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      // "unchecked" until a monitor starts. A server started without the
      // preload behaves as before: each request reaches the blob directly.
      status: "unchecked",
      reason: null,
      checkedAt: null,
      attempts: 0,
      nextRetryAt: null,
      generation: 0,
    };
  }
  return globalThis[STATE_KEY];
}

/** status: "unchecked" | "ok" | "checking" | "unavailable" | "invalid" */
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
  const { status } = state();
  return status === "ok" || status === "unchecked";
}

function resetIdentityHealthForTests(status = "ok") {
  delete globalThis[STATE_KEY];
  state().status = status;
}

module.exports = {
  identityState: state,
  setIdentityHealth,
  identityHealth,
  identityGeneration,
  identityWritable,
  resetIdentityHealthForTests,
};
