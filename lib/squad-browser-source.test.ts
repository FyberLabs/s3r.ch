import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { seaToPrincipalKey } from "./identity/forum-check";
import { createSquadBrowserSource } from "./squad-browser-source";
const key = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(key.slice(1,33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const squad = { owner, forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, label: "Browser source" }, scope = { owner, forum: squad.forumId };
const config = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
const options = { squad, config, authorityEndpoint: "/api/squad/authority", assignmentBase: "/api/squad/assignment" };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
test("disabled source performs no network IO and disable aborts/discards pending authority", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100_000 });
  let count = 0, signal: AbortSignal | null | undefined, complete: ((value: Response) => void) | undefined;
  const h = createSquadBrowserSource({ ...options, fetch: async (_url, init) => { count++; signal = init?.signal; return new Promise(resolve => { complete = resolve; }); } });
  const events: unknown[] = [], stop = h.source.subscribe(s => events.push(s));
  t.mock.timers.tick(1000); await flush(); assert.equal(count, 0);
  await assert.rejects(h.source.assignments!.read(scope)); assert.equal(count, 0);
  h.activate(); await flush(); assert.equal(count, 1);
  h.deactivate(); assert.equal(signal?.aborted, true);
  complete!(Response.json({ version: 1, forumId: squad.forumId, owner, evaluatedAt: 101, snapshot: { completeThrough: 101, rows: [], history: { completeThrough: 101, accounts: [], links: [] } } }));
  await flush(); assert.ok(events.every(s => s === null));
  stop(); h.dispose(); assert.throws(() => h.activate());
});
test("assignment scope is pinned and late results cannot cross disable/reactivation", async () => {
  let resolve: ((r: Response) => void) | undefined, calls = 0;
  const h = createSquadBrowserSource({ ...options, fetch: async (_url, init) => {
    calls++; assert.equal(init?.redirect, "error"); assert.equal(init?.mode, "same-origin"); return new Promise(r => { resolve = r; });
  } });
  h.activate();
  await assert.rejects(h.source.assignments!.abort({ ...scope, forum: "other" }, "a".repeat(32))); assert.equal(calls, 0);
  const pending = h.source.assignments!.abort(scope, "a".repeat(32));
  h.deactivate(); h.activate(); resolve!(Response.json({ ok: true }));
  await assert.rejects(pending, /changed/); h.dispose();
});
test("active source forwards fresh snapshots and disabling synchronously withdraws them", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100_000 });
  const snapshot = { completeThrough: 100, rows: [], history: { completeThrough: 100, accounts: [], links: [] } };
  const h = createSquadBrowserSource({ ...options, fetch: async () => Response.json({ version: 1, forumId: squad.forumId, owner, evaluatedAt: 100, snapshot }) });
  const events: unknown[] = []; h.source.subscribe(s => events.push(s)); h.activate();
  await flush(); assert.deepEqual(events.at(-1), snapshot);
  h.deactivate(); assert.equal(events.at(-1), null); h.dispose();
});

test("disconnect during signature confirmation prevents signed submission", async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const signing = new Promise<unknown>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const requests: string[] = [];
  const browser = createSquadBrowserSource({ ...options, fetch: async url => { requests.push(String(url)); return Response.json({}); },
    signPlan: async (_plan, _requested, context) => { entered(); await signing; assert.equal(context.signal.aborted, true); return {}; } });
  browser.activate();
  const operation = browser.source.assignments!.start({ forum: squad.forumId, owner: squad.owner }, "a".repeat(32), squad.owner, 0);
  await started; browser.deactivate(); release({});
  await assert.rejects(operation, /session changed/);
  assert.deepEqual(requests, [options.assignmentBase + "/plan"]); browser.dispose();
});

test("read-only owner source has no assignment client or assignment requests", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100_000 });
  const urls: string[] = [];
  const snapshot = { completeThrough:100, rows:[], history:{completeThrough:100,accounts:[],links:[]} };
  const browser = createSquadBrowserSource({ squad, config, authorityEndpoint:options.authorityEndpoint,
    fetch:async url=>{urls.push(String(url));return Response.json({version:1,forumId:squad.forumId,owner,evaluatedAt:100,snapshot});} });
  assert.equal(browser.source.assignments,undefined);
  const received: unknown[] = []; browser.source.subscribe(value=>received.push(value));
  browser.activate(); await flush();
  assert.deepEqual(received.at(-1),snapshot);
  assert.deepEqual(urls,[options.authorityEndpoint]);
  browser.dispose();
});
