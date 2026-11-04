import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createSquadSessions } from "./squad-session";
import { createSquadSessionHandlers } from "./squad-session-http";
import { signForumRecord } from "../forum-sign";
import { seaToPrincipalKey } from "./forum-check";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const req = (body: unknown, cookie = "", origin = "https://s3r.ch") => new Request("https://s3r.ch/api/squad/session", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
async function setup() {
  const pair = await sea.pair(); const used = new Set<string>();
  const sessions = createSquadSessions({ origin: "https://s3r.ch", secret: "s".repeat(32),
    squad: { owner: pair.pub, forumId: `forum_${seaToPrincipalKey(pair.pub)}_${"a".repeat(32)}`, label: "Test" },
    consume: async id => { if (used.has(id)) return false; used.add(id); return true; } });
  return { pair, handlers: createSquadSessionHandlers({ origin: "https://s3r.ch", sessions }) };
}
test("real SEA exchange installs only an HttpOnly session and logout clears both cookies", async () => {
  const { pair, handlers } = await setup();
  const start = await handlers.challenge(req({ key: pair.pub })); assert.equal(start.status, 200);
  const challenge = (await start.json()).challenge;
  const challengeHeader = start.headers.getSetCookie()[0];
  assert.match(challengeHeader, /Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=60/);
  const signature = await signForumRecord(challenge, pair);
  const done = await handlers.exchange(req({ challenge, signature }, challengeHeader.split(";")[0]));
  assert.equal(done.status, 200); assert.deepEqual(await done.json(), { ok: true });
  const session = done.headers.getSetCookie().find(c => c.startsWith("__Host-s3rch-squad-session="))!;
  assert.match(session, /Secure; HttpOnly; SameSite=Strict; Max-Age=300/);
  assert.deepEqual(await handlers.authenticate(req({}, session.split(";")[0])), { key: pair.pub });
  assert.equal(await handlers.authenticate(req({}, session.split(";")[0] + "; " + session.split(";")[0])), null);
  const logout = await handlers.logout(req({}));
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.ok(logout.headers.getSetCookie().every(c => c.endsWith("Max-Age=0")));
  assert.equal(logout.headers.get("cache-control"), "no-store");
});
test("login proof from another browser cannot establish a session", async () => {
  const { pair, handlers } = await setup();
  const start = await handlers.challenge(req({ key: pair.pub }));
  const { challenge } = await start.json(); const signature = await signForumRecord(challenge, pair);
  assert.equal((await handlers.exchange(req({ challenge, signature }))).status, 403);
  assert.equal((await handlers.exchange(req({ challenge, signature }, start.headers.getSetCookie()[0].split(";")[0], "https://evil.example"))).status, 403);
  assert.equal((await handlers.challenge(req({ key: pair.pub, actor: pair.pub }))).status, 400);
  assert.equal((await handlers.challenge(req({ key: "x".repeat(25000) }))).status, 413);
  assert.equal((await handlers.logout(req({}, "", "https://evil.example"))).status, 403);
});

test("composed service admits the proven cookie key and still denies missing forum authority", async () => {
  const { createSquadHttpServices } = await import("../squad-http-services");
  const { p256 } = await import("@noble/curves/nist.js");
  const { parseForumAuthority } = await import("./forum-authority-records");
  const pair = await sea.pair(), at = 1700000060;
  const squad = { owner: pair.pub, forumId: `forum_${seaToPrincipalKey(pair.pub)}_${"b".repeat(32)}`, label: "Integrated" };
  const record = { object: squad.forumId, owner: pair.pub, issuedAt: at - 1, sig: "pending" };
  const parsed = parseForumAuthority("object", record)!;
  record.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(pair.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
  let present = true, used = false;
  const services = createSquadHttpServices({ squad, origin: "https://s3r.ch", secret: "s".repeat(32), clock: () => at,
    config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] },
    consume: async () => { if (used) return false; used = true; return true; },
    read: async () => ({ completeThrough: at, history: { completeThrough: at, links: [], accounts: [{ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] }] },
      rows: present ? [{ kind: "object", soul: parsed.soul, record }] : [] }) });
  const start = await services.challenge(req({ key: pair.pub }));
  const { challenge } = await start.json();
  const signed = await services.exchange(req({ challenge, signature: await signForumRecord(challenge, pair) }, start.headers.getSetCookie()[0].split(";")[0]));
  const cookie = signed.headers.getSetCookie().find(c => c.startsWith("__Host-s3rch-squad-session="))!.split(";")[0];
  const body = { version: 1, forumId: squad.forumId, owner: pair.pub, evaluatedAt: at };
  assert.equal((await services.authority(req(body))).status, 403);
  assert.equal((await services.authority(req(body, cookie))).status, 200);
  present = false; assert.equal((await services.authority(req(body, cookie))).status, 503);
});
