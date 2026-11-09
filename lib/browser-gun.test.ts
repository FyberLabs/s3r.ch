import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createBrowserGunPool } from "./browser-gun";

const Gun = createRequire(import.meta.url)("gun/browser");

test("overlapping consumers share one root and keep independent listeners on a Gun chain", async () => {
  const root = Gun({ peers: [], localStorage: false, WebSocket: false });
  const chain = root.get("shared-scope");
  let opens = 0, closes = 0;
  const acquire = createBrowserGunPool(async (_origin, _account, signal, status) => {
    opens++;
    signal.addEventListener("abort", () => closes++);
    status(true);
    return root;
  });
  const a = acquire("https://example.org");
  const b = acquire("https://example.org");
  const [first, second] = await Promise.all([a.ready, b.ready]);
  assert.equal(opens, 1);
  const statuses: boolean[] = [];
  b.onStatus(up => statuses.push(up));
  assert.deepEqual(statuses, [true]);
  const seen: unknown[] = [];
  first.get("shared-scope").on(value => seen.push(value));
  const got = new Promise<void>(resolve => second.get("shared-scope").on(() => resolve()));
  assert.equal(Object.keys(chain._.any).length, 2);
  a.release();
  a.release();
  assert.equal(Object.keys(chain._.any).length, 1);
  assert.equal(closes, 0);
  assert.throws(() => first.get("shared-scope").put({ name: "released" }));
  second.get("shared-scope").put({ name: "remaining" });
  await got;
  assert.deepEqual(seen, []);
  b.release();
  assert.equal(Object.keys(chain._.any).length, 0);
  assert.equal(closes, 1);
});

test("cancel before startup, isolate account TURN settings, and reopen after final release", async () => {
  const opened: string[] = [];
  const stopped: string[] = [];
  const acquire = createBrowserGunPool(async (_origin, account, signal) => {
    opened.push(account);
    signal.addEventListener("abort", () => stopped.push(account));
    return Gun({ peers: [], localStorage: false, WebSocket: false });
  });
  const cancelled = acquire("https://example.org");
  cancelled.release();
  await assert.rejects(cancelled.ready, { name: "AbortError" });
  assert.deepEqual(opened, []);
  const leases = ["", "account-a", "account-b", "account-a"].map(account => acquire("https://example.org", account));
  await Promise.all(leases.map(lease => lease.ready));
  assert.deepEqual(opened, ["", "account-a", "account-b"]);
  for (const lease of leases) lease.release();
  assert.deepEqual(stopped, ["", "account-b", "account-a"]);
  const reopened = acquire("https://example.org");
  await reopened.ready;
  reopened.release();
  assert.equal(opened.length, 4);
});
