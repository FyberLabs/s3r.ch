import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createBlockingWorker, workerStartTimeoutMs, DEFAULT_WORKER_START_TIMEOUT_MS } = require("../../identity-blob.cjs");

function fixture(source: string): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "s3rch-worker-start-"));
  const file = join(dir, "worker.cjs");
  writeFileSync(file, source);
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("identity blob worker start", () => {
  it("defaults to 60 s and reads S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS", () => {
    assert.equal(DEFAULT_WORKER_START_TIMEOUT_MS, 60000);
    assert.equal(workerStartTimeoutMs({}), 60000);
    assert.equal(workerStartTimeoutMs({ S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS: "90000" }), 90000);
    assert.equal(workerStartTimeoutMs({ S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS: "999999" }), 120000);
    assert.equal(workerStartTimeoutMs({ S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS: "abc" }), 60000);
    assert.equal(workerStartTimeoutMs({ S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS: "10" }), 60000);
  });

  it("names a start timeout instead of reporting storage as unreachable", () => {
    const { file, done } = fixture(`require("node:worker_threads").parentPort.on("message", () => {});`);
    try {
      assert.throws(
        () => createBlockingWorker(file, {}, 3000, 1000),
        /identity blob worker did not start within 1s \(S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS\)/,
      );
    } finally {
      done();
    }
  });

  it("reports the worker's own error", () => {
    const { file, done } = fixture(`
      require("node:worker_threads").parentPort.on("message", (msg) => {
        msg.port.postMessage({ ok: false, reason: "load-failed", detail: "cannot load @azure/identity" });
        const shared = new Int32Array(msg.shared);
        Atomics.store(shared, 0, 1);
        Atomics.notify(shared, 0);
      });
    `);
    try {
      assert.throws(
        () => createBlockingWorker(file, {}, 3000, 5000),
        /worker failed to start \(load-failed\): cannot load @azure\/identity/,
      );
    } finally {
      done();
    }
  });

  it("does not pass -r preloads into the worker", () => {
    const { file, done } = fixture(`
      require("node:worker_threads").parentPort.on("message", (msg) => {
        msg.port.postMessage({ ok: true, execArgv: process.execArgv });
        const shared = new Int32Array(msg.shared);
        Atomics.store(shared, 0, 1);
        Atomics.notify(shared, 0);
      });
    `);
    try {
      const bridge = createBlockingWorker(file, {}, 3000, 5000);
      bridge.terminate();
    } finally {
      done();
    }
    const source = require("node:fs").readFileSync(new URL("../../identity-blob.cjs", import.meta.url), "utf8");
    assert.match(source, /new Worker\(workerPath, \{ env: workerEnv\(\), execArgv: \[\] \}\)/);
  });

  it("the preload skips the storage check inside worker threads", () => {
    const { spawnSync } = require("node:child_process");
    const program = `
      const { Worker } = require("node:worker_threads");
      const w = new Worker("require('node:worker_threads').parentPort.postMessage('ran')", { eval: true });
      w.on("message", (m) => { process.stdout.write(m); w.terminate(); });
    `;
    // NODE_ENV is not production, so the main-thread check is a no-op too; the
    // worker must not throw while loading the inherited preload.
    const result = spawnSync(process.execPath, ["-r", "./gun-preload.cjs", "-e", program], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.stdout, "ran", result.stderr);
  });
});
