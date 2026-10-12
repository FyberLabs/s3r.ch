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
      log: quietLog,
    });
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();
    assert.equal(monitor.identityHealth().status, "invalid");
    assert.equal(monitor.identityWritable({ NODE_ENV: "production" }), false);
    assert.equal(scheduled, 1);
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
      const probe = monitor.probeInWorker(20000);
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
