import assert from "node:assert/strict";
import test from "node:test";
import rotations from "./vectors/forum-rotation-record.json";
import witnesses from "./vectors/forum-witness.json";
import { verifyForumRotationProofBinding } from "./forum-rotation-proof-binding";
import { verifyForumRotationWitness } from "./forum-rotation-witness";
import type { ForumWitnessKey } from "./forum-witness-verification";
const keys = witnesses.keys as ForumWitnessKey[];
const v3 = rotations.accept.find(v => "nextEpub" in v.input)!.input;

test("upstream v4 witness binds the exact UTF-8 length-prefixed SIWE proof", async () => {
  const result = await verifyForumRotationProofBinding(v3, keys, v3.issuedAt + 100000);
  assert.ok(result);
  assert.equal(result.witnessClaims.typ, "sociacl-rotate-attest-v4");
  assert.deepEqual(result.record, v3);
});

test("replaced proof remains conflict evidence but fails direct proof binding", async () => {
  const original = v3.authorizer.siwe!;
  for (const siwe of [
    { ...original, message: original.message + " " },
    { ...original, message: original.message.replaceAll("\n", "\r\n") },
    { ...original, message: "changed é 🔑" },
    { ...original, signature: "0x" + "00".repeat(65) },
    { ...original, signature: "0x" + original.signature.slice(2).toUpperCase() },
    null,
  ]) {
    const input = { ...v3, authorizer: { ...v3.authorizer, siwe } };
    assert.ok(verifyForumRotationWitness(input, keys, v3.issuedAt));
    assert.equal(await verifyForumRotationProofBinding(input, keys, v3.issuedAt), null);
  }
});

test("legacy witnesses do not invent a proof commitment or authenticate SIWE", async () => {
  const v2 = rotations.accept[0].input;
  const input = { ...v2, authorizer: { ...v2.authorizer, siwe: { message: "", signature: "0x" + "00".repeat(65) } } };
  const evidence = await verifyForumRotationProofBinding(input, keys, v2.issuedAt);
  assert.ok(evidence);
  assert.equal(evidence.recoveryProof, "unverified");
  assert.equal("siweHash" in evidence.witnessClaims, false);
  assert.equal(await verifyForumRotationProofBinding({ ...v2, authorizer: { ...v2.authorizer, siwe: null } }, keys, v2.issuedAt), null);
});

test("binding uses a detached snapshot across the asynchronous hash", async () => {
  const input = structuredClone(v3);
  const pending = verifyForumRotationProofBinding(input, keys, input.issuedAt);
  input.authorizer.siwe!.message = "mutated after verification";
  input.attest = "mutated";
  const result = await pending;
  assert.ok(result);
  assert.deepEqual(result.record, v3);
});

test("missing trust, future records and forged signatures still deny", async () => {
  assert.equal(await verifyForumRotationProofBinding(v3, [], v3.issuedAt), null);
  assert.equal(await verifyForumRotationProofBinding(v3, keys, v3.issuedAt - 1), null);
  assert.equal(await verifyForumRotationProofBinding({ ...v3, nextSig: "forged" }, keys, v3.issuedAt), null);
});
