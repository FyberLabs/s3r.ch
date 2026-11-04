import assert from "node:assert/strict";
import test from "node:test";
import { createForumAuthoritySource } from "./forum-authority-source";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
const config = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
const snapshot = (at: number): ForumAuthoritySnapshot => ({ completeThrough: at, history: { completeThrough: at, accounts: [], links: [] }, rows: [] });
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test("source invalidates every second and never relabels late responses", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const reads: { at: number; signal: AbortSignal; resolve: (s: ForumAuthoritySnapshot) => void }[] = [];
  const events: [ForumAuthoritySnapshot | null, number][] = [];
  const source = createForumAuthoritySource({ config, read: (at, signal) => new Promise(resolve => reads.push({ at, signal, resolve })) });
  const stop = source.subscribe((s, at) => events.push([s, at]));
  await flush(); assert.deepEqual(events, [[null, 100]]);
  t.mock.timers.tick(1000); await flush();
  assert.equal(reads[0].signal.aborted, true);
  reads[0].resolve(snapshot(100)); await flush();
  assert.ok(events.every(([s]) => s === null));
  reads[1].resolve(snapshot(101)); await flush();
  assert.deepEqual(events.at(-1), [snapshot(101), 101]);
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual(events.at(-1), [null, 102]);
  stop(); const count = events.length;
  reads[2].resolve(snapshot(102)); await flush(); t.mock.timers.tick(2000); await flush();
  assert.equal(events.length, count); assert.equal(reads.length, 3);
});

test("incomplete history, failures and timeout remain denied; a later read recovers", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const events: (ForumAuthoritySnapshot | null)[] = [];
  let signal: AbortSignal | undefined;
  const source = createForumAuthoritySource({ config, read: async (at, s) => {
    if (at === 100) return { ...snapshot(at), history: snapshot(at - 1).history };
    if (at === 101) throw Error("transport unavailable");
    if (at === 102) { signal = s; return new Promise(() => {}); }
    return snapshot(at);
  } });
  const stop = source.subscribe(s => events.push(s));
  await flush(); t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(1000); await flush(); t.mock.timers.tick(800); await flush();
  assert.equal(signal?.aborted, true); assert.ok(events.every(s => s === null));
  t.mock.timers.tick(200); await flush(); assert.deepEqual(events.at(-1), snapshot(103)); stop();
});

test("source snapshots policy and independent subscriptions cancel separately", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const policy = structuredClone(config);
  const signals: AbortSignal[] = [];
  const source = createForumAuthoritySource({ config: policy, read: async (at, signal) => { signals.push(signal); return snapshot(at); } });
  policy.policy.allowedDomains.push("untrusted.example" as never);
  assert.deepEqual(source.config.policy.allowedDomains, []);
  const a: unknown[] = [], b: unknown[] = [];
  const stopA = source.subscribe(s => a.push(s)), stopB = source.subscribe(s => b.push(s));
  await flush(); stopA(); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  const count = a.length; t.mock.timers.tick(1000); await flush();
  assert.equal(a.length, count); assert.deepEqual(b.at(-1), snapshot(101)); stopB();
});

test("clock rollback cannot resurrect a previously evaluated generation", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const reads: number[] = [], events: (ForumAuthoritySnapshot | null)[] = [];
  const source = createForumAuthoritySource({ config, read: async at => { reads.push(at); return snapshot(at); } });
  const stop = source.subscribe(s => events.push(s));
  await flush();
  let wallClock = 99_000;
  t.mock.method(Date, "now", () => wallClock);
  t.mock.timers.tick(100); await flush();
  assert.equal(events.at(-1), null); assert.deepEqual(reads, [100]);
  wallClock = 100_000; t.mock.timers.tick(100); await flush();
  assert.equal(events.at(-1), null); assert.deepEqual(reads, [100]);
  wallClock = 101_000; t.mock.timers.tick(100); await flush();
  assert.deepEqual(events.at(-1), snapshot(101)); stop();
});
