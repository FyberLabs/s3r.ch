import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import rotations from "./vectors/forum-rotation-record.json";
import witnesses from "./vectors/forum-witness.json";
import { parseForumRotationRecord } from "./forum-rotation-record";
import { verifyForumRotationWitness } from "./forum-rotation-witness";
import type { ForumWitnessKey } from "./forum-witness-verification";
const keys = witnesses.keys as ForumWitnessKey[];
const base = rotations.accept[0].input;
const secret = new Uint8Array(32); secret[31] = 7;
const pub = p256.getPublicKey(secret, false);
const b64 = (v: string | Uint8Array) => Buffer.from(v).toString("base64url");
const key: ForumWitnessKey = { kid: "test", kty: "EC", crv: "P-256", x: b64(pub.slice(1,33)), y: b64(pub.slice(33)), notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER };
const claims = (r = base): Record<string, unknown> => ({ typ: "sociacl-rotate-attest-v2", principal: r.principal, nextKey: r.nextKey, seq: r.seq, iat: r.issuedAt, exp: r.issuedAt + 600, auth: r.authorizer.kind, linkId: r.authorizer.link, retainedLinks: r.retainedLinks });
function attest(c: Record<string, unknown>): string {
  const msg = b64(JSON.stringify({ alg: "ES256", kid: "test" })) + "." + b64(JSON.stringify(c));
  return msg + "." + b64(p256.sign(new TextEncoder().encode(msg), secret, { prehash: true, format: "compact" }));
}

test("upstream rotation witnesses survive expiry and damaged unsigned proof copies", () => {
  for (const vector of rotations.accept) {
    const result = verifyForumRotationWitness(vector.input, keys, vector.input.issuedAt + 100000);
    assert.ok(result, vector.name);
    const damaged = verifyForumRotationWitness({ ...vector.input, authorizer: { ...vector.input.authorizer, siwe: null } }, keys, vector.input.issuedAt);
    assert.ok(damaged);
    assert.equal(damaged.recoveryProof, "malformed");
    assert.deepEqual(damaged.witnessClaims, result.witnessClaims);
    assert.ok(Object.isFrozen(result));
  }
});

test("correctly signed witnesses must bind every transition claim", () => {
  assert.ok(verifyForumRotationWitness({ ...base, attest: attest(claims()) }, [key], base.issuedAt));
  for (const patch of [
    { typ: "sociacl-wallet-attest-v1" }, { principal: base.nextKey }, { nextKey: base.prevKey },
    { seq: base.seq + 1 }, { iat: base.issuedAt - 1 }, { auth: "oidc-fresh-login" },
    { linkId: "0".repeat(64) }, { retainedLinks: [] }, { retainedLinks: ["0".repeat(64)] },
    { retainedLinks: null }, { nextEpub: base.principal }, { siweHash: "0".repeat(64) }, { extra: true },
  ]) assert.equal(verifyForumRotationWitness({ ...base, attest: attest({ ...claims(), ...patch }) }, [key], base.issuedAt), null);
  for (const field of Object.keys(claims())) {
    const c = claims(); delete c[field];
    assert.equal(verifyForumRotationWitness({ ...base, attest: attest(c) }, [key], base.issuedAt), null, field);
  }
});

test("v3 records select wallet v4 or OIDC v3 witnesses without version downgrade", () => {
  const v3 = rotations.accept.find(v => "nextEpub" in v.input)!.input;
  const c = { ...claims(v3), typ: "sociacl-rotate-attest-v4", nextEpub: v3.nextEpub, siweHash: "a".repeat(64) };
  assert.ok(verifyForumRotationWitness({ ...v3, attest: attest(c) }, [key], v3.issuedAt));
  for (const patch of [{ typ: "sociacl-rotate-attest-v2" }, { typ: "sociacl-rotate-attest-v3" }, { nextEpub: base.principal }, { siweHash: undefined }, { siweHash: "A".repeat(64) }]) {
    assert.equal(verifyForumRotationWitness({ ...v3, attest: attest({ ...c, ...patch }) }, [key], v3.issuedAt), null);
  }
  const oidc = { ...v3, authorizer: { kind: "oidc-fresh-login", link: v3.authorizer.link } };
  const parsed = parseForumRotationRecord(oidc)!;
  const nextSecret = new Uint8Array(32); nextSecret[31] = 2;
  const signed = { ...oidc, nextSig: b64(p256.sign(parsed.bytes, nextSecret, { prehash: true, format: "compact" })) };
  const oc = { ...claims(), typ: "sociacl-rotate-attest-v3", auth: "oidc-fresh-login", nextEpub: v3.nextEpub };
  assert.ok(verifyForumRotationWitness({ ...signed, attest: attest(oc) }, [key], v3.issuedAt));
  assert.equal(verifyForumRotationWitness({ ...signed, attest: attest({ ...oc, siweHash: "a".repeat(64) }) }, [key], v3.issuedAt), null);
});

test("signature, trust and evaluation time failures reject before admitting evidence", () => {
  assert.equal(verifyForumRotationWitness(base, [], base.issuedAt), null);
  for (const now of [base.issuedAt - 1, -0, NaN, Infinity, -1, 1.5]) assert.equal(verifyForumRotationWitness(base, keys, now), null);
  for (const patch of [{ nextSig: "x" }, { attest: "forged" }, { seq: 2 }, { prevKey: base.nextKey }]) {
    assert.equal(verifyForumRotationWitness({ ...base, ...patch }, keys, base.issuedAt), null);
  }
});
