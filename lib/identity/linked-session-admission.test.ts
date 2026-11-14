import assert from "node:assert/strict";
import test from "node:test";
import { linkedSessionFixture } from "../../scripts/fixtures/linked-session";
import { createIdentitySessions } from "./sea-session";
import { createSeaSessionHandlers } from "./sea-session-http";
import { siteSeaSession } from "./site-sea-session-server";
const origin = "https://s3r.ch";
for (const kind of ["wallet", "oidc"] as const) {
  test(`${kind}: signed link and fresh credential proof yield the same SEA issuer session; replay loses`, async () => {
    const h = await linkedSessionFixture(kind), challenge = await h.sessions.linkedChallenge(h.credential); assert.ok(challenge);
    const proof = await h.proof(challenge);
    const tokens = await Promise.all([h.sessions.exchangeLinked(challenge, proof), h.sessions.exchangeLinked(challenge, proof)]);
    assert.equal(tokens.filter(Boolean).length, 1);
    assert.deepEqual(await h.sessions.authenticate(tokens.find(Boolean)!), { key: h.principal });
    assert.equal(await h.sessions.authenticate(challenge), null);
    assert.equal(await h.sessions.exchangeLinked(tokens.find(Boolean)!, proof), null);
  });
  test(`${kind}: two eligible identities refuse despite different link timestamps`, async () => {
    const h = await linkedSessionFixture(kind); await h.conflict();
    assert.equal(await h.sessions.linkedChallenge(h.credential), null);
  });
  test(`${kind}: replacement link cannot reuse a challenge bound to the old link`, async () => {
    const h = await linkedSessionFixture(kind), challenge = (await h.sessions.linkedChallenge(h.credential))!;
    const proof = await h.proof(challenge); await h.replace();
    assert.ok(await h.sessions.linkedChallenge(h.credential));
    assert.equal(await h.sessions.exchangeLinked(challenge, proof), null);
  });
  test(`${kind}: replay storage failure cannot issue a session`, async () => {
    const h = await linkedSessionFixture(kind), challenge = (await h.sessions.linkedChallenge(h.credential))!;
    const proof = await h.proof(challenge);
    for (const consume of [async () => false, async () => { throw Error("offline"); }])
      assert.equal(await createIdentitySessions({ ...h.options, consume }).exchangeLinked(challenge, proof), null);
  });
  test(`${kind}: missing, stale, unavailable, corrupt, revoked and incomplete evidence cannot issue`, async () => {
    for (const failure of ["missing", "stale", "unavailable", "tamper", "revoke", "badHistory"] as const) {
      const h = await linkedSessionFixture(kind), challenge = await h.sessions.linkedChallenge(h.credential); assert.ok(challenge);
      const proof = await h.proof(challenge); h[failure]();
      assert.equal(await h.sessions.linkedChallenge(h.credential), null, failure);
      assert.equal(await h.sessions.exchangeLinked(challenge, proof), null, failure);
      assert.equal(h.used.size, 0, failure);
    }
  });
  test(`${kind}: revocation or expiry during consume burns proof without session`, async () => {
    for (const action of ["revoke", "advance", "unavailable", "rotate"] as const) {
      const h = await linkedSessionFixture(kind), challenge = (await h.sessions.linkedChallenge(h.credential))!;
      const proof = await h.proof(challenge); h.onConsume(h[action]);
      assert.equal(await h.sessions.exchangeLinked(challenge, proof), null); assert.equal(h.used.size, 1);
    }
  });
  test(`${kind}: origin, backend, proof and expiry cannot be substituted`, async () => {
    const h = await linkedSessionFixture(kind), challenge = (await h.sessions.linkedChallenge(h.credential))!;
    const proof = await h.proof(challenge);
    assert.throws(() => createIdentitySessions({ ...h.options, origin: "https://other.example" }), /origin mismatch/);
    for (const change of [{ challengeDomain: "a".repeat(64) }, { linkedAdmission: undefined }])
      assert.equal(await createIdentitySessions({ ...h.options, ...change }).exchangeLinked(challenge, proof), null);
    const otherChallenge = (await h.sessions.linkedChallenge(h.credential))!;
    assert.equal(await h.sessions.exchangeLinked(otherChallenge, proof), null);
    h.advance(); assert.equal(await h.sessions.exchangeLinked(challenge, proof), null);
  });
}
test("OIDC fresh login binds nonce, tenant, authentication time and issuer-configured audience", async () => {
  const h = await linkedSessionFixture("oidc"), challenge = (await h.sessions.linkedChallenge(h.credential))!;
  for (const override of [{ nonce: "wrong" }, { tenant_id: "other" }, { auth_time: 199 }, { auth_time: 201 },
    { sub: "another-person" }, { iss: "https://other.example" }, { aud: "another-client" }, { aud: ["site", "another-client"] }, { azp: "another-client" }])
    assert.equal(await h.sessions.exchangeLinked(challenge, await h.proof(challenge, override)), null);
});
test("linked HTTP challenge is same-origin and cookie-bound; hosted source absence refuses without IO", async () => {
  const h = await linkedSessionFixture("wallet"), handlers = createSeaSessionHandlers({ origin, sessions: h.sessions });
  const req = (body: unknown, cookie = "", site = origin) => new Request(origin + "/api/identity/sea/linked-challenge", {
    method: "POST", headers: { origin: site, "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  assert.equal((await handlers["linked-challenge"](req({ credential: h.credential }, "", "https://other.example"))).status, 403);
  const started = await handlers["linked-challenge"](req({ credential: h.credential })); assert.equal(started.status, 200);
  const { challenge } = await started.json();
  const body = { challenge, proof: await h.proof(challenge) };
  assert.equal((await handlers["linked-exchange"](req(body))).status, 403);
  const exchanged = await handlers["linked-exchange"](req(body, started.headers.getSetCookie()[0].split(";")[0]));
  assert.equal(exchanged.status, 200); assert.ok(exchanged.headers.getSetCookie().some(s => s.startsWith("__Host-s3rch-squad-session=")));
  const response = await siteSeaSession(req({ credential: h.credential }), "linked-challenge", {}, async () => { assert.fail("no provider IO"); });
  assert.equal(response.status, 503);
});
