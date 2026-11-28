import assert from "node:assert/strict";
import test from "node:test";
import rotations from "./vectors/forum-rotation-record.json";
import witnesses from "./vectors/forum-witness.json";
import { verifyForumRotationProofBinding } from "./forum-rotation-proof-binding";
import { verifyForumRotationWitness } from "./forum-rotation-witness";
import { verifyForumRotationTransition } from "./forum-sociacl-rotation";
import { mintSeaForumRotation } from "./forum-rotation-test-helpers";
import type { ForumWitnessKey } from "./forum-witness-verification";
const keys = witnesses.keys as ForumWitnessKey[];
const v3 = rotations.accept.find(v => "nextEpub" in v.input)!.input;

test("deployment witness rotations are conflict evidence, not owner-chain proof binding", async () => {
  assert.ok(verifyForumRotationWitness(v3, keys, v3.issuedAt + 100000));
  assert.equal(await verifyForumRotationProofBinding(v3, v3.issuedAt + 100000), null);
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
    assert.equal(await verifyForumRotationProofBinding(input, v3.issuedAt), null);
  }
});

test("legacy deployment witness rotations are not owner-chain proof binding", async () => {
  const v2 = rotations.accept[0].input;
  const input = { ...v2, authorizer: { ...v2.authorizer, siwe: { message: "", signature: "0x" + "00".repeat(65) } } };
  assert.ok(verifyForumRotationWitness(input, keys, v2.issuedAt));
  assert.equal(await verifyForumRotationProofBinding(input, v2.issuedAt), null);
  assert.equal(await verifyForumRotationProofBinding({ ...v2, authorizer: { ...v2.authorizer, siwe: null } }, v2.issuedAt), null);
});

test("binding uses a detached snapshot across the asynchronous hash", async () => {
  const base = mintSeaForumRotation({ at: 120 });
  const input = structuredClone(base);
  const pending = verifyForumRotationProofBinding(input, input.issuedAt);
  input.authorizer.siwe = { message: "mutated after verification", signature: `0x${"00".repeat(65)}` };
  input.attest = "mutated";
  const result = await pending;
  assert.ok(result);
  assert.deepEqual(result.record, base);
});

test("deployment witness attestations are not owner-chain transitions", async () => {
  assert.equal(verifyForumRotationTransition(v3, v3.issuedAt), null);
  assert.equal(await verifyForumRotationProofBinding(v3, v3.issuedAt - 1), null);
  assert.equal(await verifyForumRotationProofBinding({ ...v3, nextSig: "forged" }, v3.issuedAt), null);
});