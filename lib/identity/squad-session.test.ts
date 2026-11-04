import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createSquadSessions } from "./squad-session";
import { signForumRecord } from "../forum-sign";
import { seaToPrincipalKey } from "./forum-check";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
async function setup() {
  const owner = await sea.pair(), other = await sea.pair();
  const squad = { owner: owner.pub, forumId: `forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`, label: "Session test" };
  const used = new Set<string>(); let now = 1700000060;
  const options = { squad, origin: "https://s3r.ch", secret: "s".repeat(32), clock: () => now,
    consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; } };
  return { owner, other, options, sessions: createSquadSessions(options), advance: (seconds: number) => { now += seconds; } };
}
test("real SEA possession issues a scoped session and concurrent replay loses", async () => {
  const h = await setup(), challenge = await h.sessions.challenge(h.owner.pub);
  assert.equal(await h.sessions.authenticate(challenge), null);
  const sig = await signForumRecord(challenge, h.owner); assert.ok(sig);
  const results = await Promise.all([h.sessions.exchange(challenge, sig), h.sessions.exchange(challenge, sig)]);
  assert.equal(results.filter(Boolean).length, 1);
  const token = results.find(Boolean)!;
  assert.deepEqual(await h.sessions.authenticate(token), { key: h.owner.pub });
  assert.equal(await h.sessions.exchange(token, sig), null);
  h.advance(300); assert.equal(await h.sessions.authenticate(token), null);
});
test("wrong signer, altered challenge, expired proof and unavailable replay storage deny", async () => {
  const h = await setup(), challenge = await h.sessions.challenge(h.owner.pub);
  assert.equal(await h.sessions.exchange(challenge, (await signForumRecord(challenge, h.other))!), null);
  const sig = (await signForumRecord(challenge, h.owner))!;
  assert.equal(await h.sessions.exchange(challenge + "x", sig), null);
  const unavailable = createSquadSessions({ ...h.options, consume: async () => { throw Error("offline"); } });
  assert.equal(await unavailable.exchange(challenge, sig), null);
  h.advance(60); assert.equal(await h.sessions.exchange(challenge, sig), null);
});
test("tokens cannot cross origin, Squad, signing secret or trust lifetime", async () => {
  const h = await setup(), challenge = await h.sessions.challenge(h.owner.pub);
  const sig = (await signForumRecord(challenge, h.owner))!;
  for (const override of [{ origin: "https://other.example" }, { secret: "x".repeat(32) },
    { squad: { ...h.options.squad, forumId: h.options.squad.forumId.replace(/a{32}$/, "b".repeat(32)) } }]) {
    assert.equal(await createSquadSessions({ ...h.options, ...override }).exchange(challenge, sig), null);
  }
  const slow = createSquadSessions({ ...h.options, consume: async () => { h.advance(60); return true; } });
  assert.equal(await slow.exchange(challenge, sig), null);
  assert.throws(() => createSquadSessions({ ...h.options, secret: "short" }));
});
