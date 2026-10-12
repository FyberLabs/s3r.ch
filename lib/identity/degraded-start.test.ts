import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { GET as health } from "../../app/api/health/route";
import { POST as oauthLink } from "../../app/api/identity/oauth/link/route";
import { getLinks, identityLinksWritable, openLinks, useLinkStore, type IdentityLinkFile, type LinkStore } from "./link";

const require = createRequire(import.meta.url);
const monitor = {
  ...(require("../../identity-health.cjs") as typeof import("../../identity-health.cjs")),
  ...(require("../../identity-monitor.cjs") as typeof import("../../identity-monitor.cjs")),
};
const WALLET = "0x1111111111111111111111111111111111111111";

function memoryStore(): LinkStore & { saves: number } {
  let file: IdentityLinkFile = { v: 1, people: [] };
  return {
    saves: 0,
    load() {
      return { ok: true, file: structuredClone(file) };
    },
    save(next) {
      this.saves += 1;
      file = structuredClone(next);
    },
  };
}

function withProduction<T>(action: () => T): T {
  const previous = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = "production";
  try {
    return action();
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = previous;
  }
}

const quietLog = { log() {}, error() {} };
let closed = 0;
function fakeClient() {
  return {
    close: async () => {
      closed += 1;
      return 0;
    },
    assertReachable() {},
    download: () => ({ found: false as const }),
    upload: () => ({ etag: "1" }),
  };
}

afterEach(() => {
  monitor.resetIdentityHealthForTests("unchecked");
  useLinkStore(null);
});

describe("identity storage monitor", () => {
  it("keeps retrying with backoff and recovers when storage comes back", async () => {
    const results = [
      { ok: false, message: "s3r.ch: identity blob storage is unreachable" },
      { ok: false, message: "s3r.ch: identity blob storage refused access." },
      { ok: true },
    ];
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    const handle = monitor.startIdentityMonitor({
      env: { NODE_ENV: "production" },
      probe: async () => results.shift() ?? { ok: true },
      schedule: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
        return 0;
      },
      connect: async () => fakeClient(),
      log: quietLog,
    });
    const generation = monitor.identityGeneration();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(monitor.identityHealth().status, "unavailable");
    assert.equal(monitor.identityWritable({ NODE_ENV: "production" }), false);
    pending.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(String(monitor.identityHealth().reason), /refused access/);
    pending.shift()!();
    await handle.done;
    assert.equal(monitor.identityHealth().status, "ok");
    assert.equal(monitor.identityWritable({ NODE_ENV: "production" }), true);
    assert.equal(monitor.identityGeneration(), generation + 1);
    assert.deepEqual(delays, [monitor.RETRY_MIN_MS, monitor.RETRY_MIN_MS * 2, monitor.RETRY_MAX_MS]);
    assert.equal(pending.length, 1);
    handle.stop();
  });

  it("keeps checking after success and notices a later outage", async () => {
    const results = [{ ok: true }, { ok: false, message: "s3r.ch: identity blob storage is unreachable" }];
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    const handle = monitor.startIdentityMonitor({
      env: { NODE_ENV: "production" },
      probe: async () => results.shift() ?? { ok: true },
      schedule: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
        return 0;
      },
      connect: async () => fakeClient(),
      log: quietLog,
    });
    await handle.done;
    assert.equal(monitor.identityHealth().status, "ok");
    pending.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();
    assert.equal(monitor.identityHealth().status, "unavailable");
    assert.deepEqual(delays, [monitor.RETRY_MAX_MS, monitor.RETRY_MIN_MS]);
  });

  it("an invalid identity document disables writes but does not stop the process", async () => {
    let scheduled = 0;
    const handle = monitor.startIdentityMonitor({
      env: { NODE_ENV: "production" },
      probe: async () => ({ ok: false, message: "s3r.ch: identity store is invalid; refusing to start" }),
      schedule: () => {
        scheduled += 1;
        return 0;
      },
      connect: async () => fakeClient(),
      log: quietLog,
    });
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();
    assert.equal(monitor.identityHealth().status, "invalid");
    assert.equal(monitor.identityWritable({ NODE_ENV: "production" }), false);
    assert.equal(scheduled, 1);
  });

  it("only the first successful check may create the blob, and outages close the client", async () => {
    const creates: boolean[] = [];
    const results = [{ ok: true }, { ok: false, message: "s3r.ch: identity blob is missing; not recreating it while running." }];
    const pending: Array<() => void> = [];
    closed = 0;
    const handle = monitor.startIdentityMonitor({
      env: { NODE_ENV: "production" },
      probe: async ({ create }) => {
        creates.push(create);
        return results.shift() ?? { ok: true };
      },
      connect: async () => fakeClient(),
      schedule: (fn) => {
        pending.push(fn);
        return 0;
      },
      log: quietLog,
    });
    await handle.done;
    assert.ok(monitor.identityClient());
    pending.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();
    assert.deepEqual(creates, [true, false]);
    assert.equal(monitor.identityHealth().status, "invalid");
    assert.equal(monitor.identityClient(), null);
    assert.equal(closed, 1);
  });

  it("a failed client start counts as a failed check", async () => {
    const handle = monitor.startIdentityMonitor({
      env: { NODE_ENV: "production" },
      probe: async () => ({ ok: true }),
      connect: async () => {
        throw new Error("s3r.ch: identity blob worker did not start within 60s");
      },
      schedule: () => 0,
      log: quietLog,
    });
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();
    assert.equal(monitor.identityHealth().status, "unavailable");
    assert.match(String(monitor.identityHealth().reason), /did not start/);
  });

  it("caps the retry delay", () => {
    assert.equal(monitor.retryDelay(1), monitor.RETRY_MIN_MS);
    assert.equal(monitor.retryDelay(50), monitor.RETRY_MAX_MS);
  });

  it("development never blocks identity writes", () => {
    monitor.setIdentityHealth("unavailable", "down");
    assert.equal(monitor.identityWritable({ NODE_ENV: "development" }), true);
  });

  it("the worker probe reports missing settings without throwing", async () => {
    const result = await withProduction(() => {
      const saved = { account: process.env.S3RCH_IDENTITY_BLOB_ACCOUNT, container: process.env.S3RCH_IDENTITY_BLOB_CONTAINER };
      delete process.env.S3RCH_IDENTITY_BLOB_ACCOUNT;
      delete process.env.S3RCH_IDENTITY_BLOB_CONTAINER;
      const probe = monitor.probeInWorker({}, 20000);
      if (saved.account !== undefined) process.env.S3RCH_IDENTITY_BLOB_ACCOUNT = saved.account;
      if (saved.container !== undefined) process.env.S3RCH_IDENTITY_BLOB_CONTAINER = saved.container;
      return probe;
    });
    assert.equal(result.ok, false);
    assert.match(String(result.message), /S3RCH_IDENTITY_BLOB_ACCOUNT/);
  });
});

describe("identity writes while storage is unavailable", () => {
  it("links are refused and nothing is written", () => {
    const store = memoryStore();
    useLinkStore(store);
    monitor.setIdentityHealth("unavailable", "down");
    const result = withProduction(() => {
      assert.equal(identityLinksWritable(), false);
      return getLinks().link({ wallet: WALLET, sub: "kc-1", idp: "github" });
    });
    assert.deepEqual(result, { denied: true, reason: "store-unreadable" });
    assert.equal(store.saves, 0);
  });

  it("links work again after recovery", () => {
    const store = memoryStore();
    useLinkStore(store);
    monitor.setIdentityHealth("unavailable", "down");
    monitor.setIdentityHealth("ok");
    const result = withProduction(() => getLinks().link({ wallet: WALLET, sub: "kc-1", idp: "github" }));
    assert.deepEqual(result, { owner: WALLET });
    assert.equal(store.saves, 1);
  });

  it("the account-link route answers 503 with Retry-After", async () => {
    monitor.setIdentityHealth("unavailable", "down");
    const response = await withProduction(() => oauthLink(new Request("https://s3r.ch/api/identity/oauth/link", { method: "POST" })));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    const body = await response.json();
    assert.equal(body.reason, "identity-storage-unavailable");
  });

  it("an unrelated store keeps reading normally", () => {
    const links = openLinks(memoryStore());
    assert.equal(links.ownerForWallet(WALLET), WALLET);
  });
});

describe("health", () => {
  it("returns 200 with per-dependency status while identity storage is down", async () => {
    monitor.setIdentityHealth("unavailable", "s3r.ch: identity blob storage is unreachable");
    const response = await health();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.dependencies.identity.status, "unavailable");
    assert.equal(body.dependencies.identity.writable, false);
    assert.ok(["ok", "not-attached"].includes(body.dependencies.gun.status));
    assert.ok(["configured", "not-configured"].includes(body.dependencies.panopticon.status));
  });
});

describe("request-time blob client", () => {
  it("starts the worker without blocking the event loop", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "s3rch-async-bridge-"));
    const file = join(dir, "worker.cjs");
    writeFileSync(file, `
      require("node:worker_threads").parentPort.on("message", (msg) => {
        setTimeout(() => {
          msg.port.postMessage({ ok: true });
          const shared = new Int32Array(msg.shared);
          Atomics.store(shared, 0, 1);
          Atomics.notify(shared, 0);
        }, 300);
      });
    `);
    const { createWorkerBridge } = require("../../identity-blob.cjs");
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 20);
    try {
      const bridge = await createWorkerBridge(file, {}, 3000, 5000);
      await bridge.terminate();
    } finally {
      clearInterval(ticker);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(ticks >= 5, `event loop ran ${ticks} ticks while the worker started`);
  });

  it("a later check reports a deleted blob instead of recreating it", () => {
    const { assertBlobReady } = require("../../identity-blob.cjs");
    let uploads = 0;
    const client = {
      assertReachable() {},
      download: () => ({ found: false }),
      upload: () => {
        uploads += 1;
        return { etag: "1" };
      },
    };
    const config = { account: "s3rchlinks", container: "identity", url: "https://s3rchlinks.blob.core.windows.net" };
    assert.throws(() => assertBlobReady(config, client, { create: false }), /identity blob is missing/);
    assert.equal(uploads, 0);
  });
});

describe("review follow-ups", () => {
  it("healthy periodic checks keep the existing client", async () => {
    let connects = 0;
    const pending: Array<() => void> = [];
    closed = 0;
    const handle = monitor.startIdentityMonitor({
      env: { NODE_ENV: "production" },
      probe: async () => ({ ok: true }),
      connect: async () => {
        connects += 1;
        return fakeClient();
      },
      schedule: (fn) => {
        pending.push(fn);
        return 0;
      },
      log: quietLog,
    });
    await handle.done;
    const first = monitor.identityClient();
    pending.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();
    assert.equal(connects, 1);
    assert.equal(monitor.identityClient(), first);
    assert.equal(closed, 0);
  });

  it("an oversized document is reported as invalid", () => {
    const { interpretBlobReply } = require("../../identity-blob.cjs");
    let message = "";
    try {
      interpretBlobReply({ ok: false, status: 413, reason: "too-large" });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.equal(monitor.classifyFailure(message).status, "invalid");
  });
});
