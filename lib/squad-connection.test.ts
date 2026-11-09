import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveSquadForum } from "../components/LiveSquadForum";
import { createSquadConnection } from "./squad-connection";
import { createSquadSessions } from "./identity/squad-session";
import { createSquadSessionHandlers } from "./identity/squad-session-http";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { SeaPair } from "./identity/sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
async function setup() {
  const pair = await sea.pair(), squad = { owner: pair.pub, forumId: `forum_${seaToPrincipalKey(pair.pub)}_${"a".repeat(32)}`, label: "Connected test Squad" };
  const options = { squad, origin: "https://s3r.ch", sessionBase: "/api/squad/session", authorityEndpoint: "/api/squad/authority", assignmentBase: "/api/squad/assignment",
    config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] } };
  const sessions = createSquadSessions({ ...options, secret: "s".repeat(32), consume: async () => true });
  const handlers = createSquadSessionHandlers({ ...options, sessions });
  const cookies = new Map<string, string>(), actions: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const action = String(url).split("/").at(-1)!; actions.push(action);
    if (action === "abort") return Response.json({ ok: true });
    const headers = new Headers(init?.headers); headers.set("origin", options.origin); headers.set("cookie", [...cookies].map(([k,v]) => `${k}=${v}`).join("; "));
    const response = await handlers[action as "challenge" | "exchange" | "logout"](new Request(options.origin + url, { ...init, headers }));
    for (const row of response.headers.getSetCookie()) { const [k,v] = row.split(";")[0].split("="); if (v) cookies.set(k,v); else cookies.delete(k); }
    return response;
  };
  return { pair, options, cookies, actions, fetcher, scope: { forum: squad.forumId, owner: pair.pub } };
}
test("connection gates transport before sign-in and withdraws synchronously on disconnect", async () => {
  const h = await setup(), states: string[] = [];
  const c = createSquadConnection({ ...h.options, fetch: h.fetcher, onState: s => states.push(s) });
  await assert.rejects(c.source.assignments!.abort(h.scope, "a".repeat(32)));
  assert.equal(await c.selectKey(h.pair), true); assert.equal(states.at(-1), "connected");
  await c.source.assignments!.abort(h.scope, "a".repeat(32));
  const logout = c.selectKey(null); assert.equal(states.at(-1), "disconnected");
  await assert.rejects(c.source.assignments!.abort(h.scope, "a".repeat(32)));
  assert.equal(await logout, true); assert.equal(h.cookies.size, 0); c.dispose();
});
test("superseded login cannot reactivate authority after logout or disposal", async () => {
  const h = await setup(); let release: (() => void) | undefined;
  const gate = new Promise<void>(r => { release = r; });
  const c = createSquadConnection({ ...h.options, fetch: async (url, init) => { await gate; return h.fetcher(url, init); } });
  const login = c.selectKey(h.pair); await Promise.resolve();
  const logout = c.selectKey(null); release!();
  assert.equal(await login, false); await logout;
  await assert.rejects(c.source.assignments!.abort(h.scope, "a".repeat(32)));
  c.dispose(); assert.equal(await c.selectKey(h.pair), false);
});
test("connection expires before the five-minute server session", async t => {
  const h = await setup();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1700000000000 });
  const states: string[] = [], c = createSquadConnection({ ...h.options, fetch: h.fetcher, onState: s => states.push(s) });
  assert.equal(await c.selectKey(h.pair), true);
  t.mock.timers.tick(240000); assert.equal(states.at(-1), "disconnected");
  await assert.rejects(c.source.assignments!.abort(h.scope, "a".repeat(32))); c.dispose();
});
test("live wrapper renders empty and disconnected before client authentication", async () => {
  const h = await setup();
  const html = renderToStaticMarkup(createElement(LiveSquadForum, { ...h.options, pair: null }));
  assert.match(html, /Disconnected/); assert.match(html, /Connect Squad/); assert.match(html, /Connected test Squad/);
  assert.doesNotMatch(html, /Squad · preview/);
});
