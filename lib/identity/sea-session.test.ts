import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createIdentitySessions } from "./sea-session";
import { signForumRecord } from "../forum-sign";
import { seaToPrincipalKey } from "./forum-check";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
async function setup() {
  const owner = await sea.pair(), other = await sea.pair();
  const squad = { owner: owner.pub, forumId: `forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`, label: "Session test" };
  const used = new Set<string>(); let now = 1700000060;
  const options = { origin: "https://s3r.ch", secret: "s".repeat(32), clock: () => now,
    consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; } };
  return { owner, other, options, sessions: createIdentitySessions(options), advance: (seconds: number) => { now += seconds; } };
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
  const unavailable = createIdentitySessions({ ...h.options, consume: async () => { throw Error("offline"); } });
  assert.equal(await unavailable.exchange(challenge, sig), null);
  h.advance(60); assert.equal(await h.sessions.exchange(challenge, sig), null);
});
test("tokens cannot cross origin, signing secret or trust lifetime", async () => {
  const h = await setup(), challenge = await h.sessions.challenge(h.owner.pub);
  const sig = (await signForumRecord(challenge, h.owner))!;
  for (const override of [{ origin: "https://other.example" }, { secret: "x".repeat(32) }]) {
    assert.equal(await createIdentitySessions({ ...h.options, ...override }).exchange(challenge, sig), null);
  }
  const slow = createIdentitySessions({ ...h.options, consume: async () => { h.advance(60); return true; } });
  assert.equal(await slow.exchange(challenge, sig), null);
  assert.throws(() => createIdentitySessions({ ...h.options, secret: "short" }));
});

test("session issuance requires an exact HTTPS origin, including local configuration", async () => {
  const h = await setup();
  for (const origin of ["http://s3r.ch", "http://localhost:8080", "http://127.0.0.1:8080",
    "https://s3r.ch/", "https://s3r.ch/path", "https://user:pass@s3r.ch", "https://s3r.ch?x=1",
    "https://s3r.ch#fragment", "https://S3R.CH", "ftp://s3r.ch"]) {
    assert.throws(() => createIdentitySessions({ ...h.options, origin }), /Canonical HTTPS origin required/, origin);
  }
  const sessions = createIdentitySessions({ ...h.options, origin: "https://localhost:8443" });
  const challenge = await sessions.challenge(h.owner.pub);
  const signature = await signForumRecord(challenge, h.owner);
  assert.ok(signature);
  const token = await sessions.exchange(challenge, signature);
  assert.ok(token);
  assert.deepEqual(await sessions.authenticate(token), { key: h.owner.pub });
});

test("site sessions share identity across apps while challenge replay is global", async () => {
  const h = await setup();
  const secondApp = createIdentitySessions(h.options);
  const challenge = await h.sessions.challenge(h.owner.pub);
  const signature = (await signForumRecord(challenge, h.owner))!;
  const token = await secondApp.exchange(challenge, signature);
  assert.ok(token);
  assert.deepEqual(await h.sessions.authenticate(token), { key: h.owner.pub });
  assert.equal(await h.sessions.exchange(challenge, signature), null);
});

test("backend-bound challenges cannot be exchanged across replay stores during migration", async () => {
  const h = await setup(); let legacyCalls = 0, remoteCalls = 0;
  const legacy = createIdentitySessions({ ...h.options, consume: async () => { legacyCalls++; return true; } });
  const remote = createIdentitySessions({ ...h.options, challengeDomain: "a".repeat(64), consume: async () => { remoteCalls++; return true; } });
  const other = createIdentitySessions({ ...h.options, challengeDomain: "b".repeat(64) });
  const oldChallenge = await legacy.challenge(h.owner.pub), newChallenge = await remote.challenge(h.owner.pub);
  const oldProof = (await signForumRecord(oldChallenge, h.owner))!, newProof = (await signForumRecord(newChallenge, h.owner))!;
  assert.equal(await remote.exchange(oldChallenge, oldProof), null);
  assert.equal(await legacy.exchange(newChallenge, newProof), null);
  assert.equal(await other.exchange(newChallenge, newProof), null);
  assert.equal(legacyCalls, 0); assert.equal(remoteCalls, 0);
  const oldSession = await legacy.exchange(oldChallenge, oldProof), newSession = await remote.exchange(newChallenge, newProof);
  assert.ok(oldSession); assert.ok(newSession);
  assert.deepEqual(await remote.authenticate(oldSession), { key: h.owner.pub });
  assert.deepEqual(await legacy.authenticate(newSession), { key: h.owner.pub });
  assert.throws(() => createIdentitySessions({ ...h.options, challengeDomain: "not-a-domain" }));
});
