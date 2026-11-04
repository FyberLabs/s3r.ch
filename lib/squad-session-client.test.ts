import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createSquadSessionClient } from "./squad-session-client";
import { createSquadSessions } from "./identity/squad-session";
import { createSquadSessionHandlers } from "./identity/squad-session-http";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { SeaPair } from "./identity/sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
async function setup() {
  const pair = await sea.pair(), squad = { owner: pair.pub, forumId: `forum_${seaToPrincipalKey(pair.pub)}_${"a".repeat(32)}`, label: "Client test" };
  const sessions = createSquadSessions({ squad, origin: "https://s3r.ch", secret: "s".repeat(32), consume: async () => true });
  const handlers = createSquadSessionHandlers({ origin: "https://s3r.ch", sessions });
  const cookies = new Map<string, string>(); const actions: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "same-origin"); assert.equal(init?.mode, "same-origin");
    const action = String(url).split("/").at(-1) as "challenge" | "exchange" | "logout"; actions.push(action);
    const headers = new Headers(init?.headers); headers.set("origin", "https://s3r.ch"); headers.set("cookie", [...cookies].map(([k,v]) => `${k}=${v}`).join("; "));
    const res = await handlers[action](new Request(`https://s3r.ch${url}`, { ...init, headers }));
    for (const row of res.headers.getSetCookie()) { const [k,v] = row.split(";")[0].split("="); if (v) cookies.set(k,v); else cookies.delete(k); }
    return res;
  };
  return { pair, squad, sessions, cookies, actions, fetcher };
}
test("browser client signs in with real SEA proof and clears cookies on logout", async () => {
  const h = await setup(), client = createSquadSessionClient({ base: "/api/squad/session", origin: "https://s3r.ch", squad: h.squad, fetch: h.fetcher });
  assert.equal(await client.signIn(h.pair), true);
  assert.deepEqual(await h.sessions.authenticate(h.cookies.get("__Host-s3rch-squad-session")!), { key: h.pair.pub });
  assert.equal(await client.logout(), true); assert.equal(h.cookies.size, 0);
  assert.deepEqual(h.actions, ["challenge", "exchange", "logout"]);
});
test("wrong-scope challenges and aborted sign-in never reach exchange", async () => {
  const h = await setup(); let exchanges = 0;
  const foreign = createSquadSessions({ squad: { ...h.squad, forumId: h.squad.forumId.replace(/a{32}$/, "b".repeat(32)) }, origin: "https://s3r.ch", secret: "s".repeat(32), consume: async () => true });
  const client = createSquadSessionClient({ base: "/api/squad/session", origin: "https://s3r.ch", squad: h.squad,
    fetch: async url => { if (String(url).endsWith("exchange")) exchanges++; return Response.json({ challenge: await foreign.challenge(h.pair.pub) }); } });
  assert.equal(await client.signIn(h.pair), false); assert.equal(exchanges, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal(await client.signIn(h.pair, controller.signal), false); assert.equal(exchanges, 0);
});
