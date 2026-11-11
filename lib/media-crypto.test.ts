import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { MEDIA_PLAIN_MAX, MEDIA_STORED_MAX, sealMedia, openMedia } from "./media-crypto";
const binding = { tenant: "afee9b29-1706-5590-bbbf-e58df8945ac0", object: "claim_" + "12".repeat(32) };
const input = new Uint8Array([0, 255, 128, 1, 0, 40]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("media round trip preserves binary bytes and stores only a versioned opaque envelope", async () => {
  const a = await sealMedia(input, binding), b = await sealMedia(input, binding);
  assert.equal(a.bytes.length, input.length + 32);
  assert.equal(a.sha256, hash(a.bytes));
  assert.notEqual(a.sha256, b.sha256); assert.notDeepEqual(a.key, b.key);
  assert.equal(a.key.length, 32);
  assert.deepEqual(await openMedia(a.bytes, a.sha256, a.key, binding), input);
  assert.deepEqual(await openMedia(a.bytes, a.sha256, a.key, binding), input);
});
test("media authenticates ciphertext, nonce, key and tenant/object binding", async () => {
  const a = await sealMedia(input, binding);
  for (const offset of [4, 15, 16, a.bytes.length - 1]) {
    const tampered = a.bytes.slice(); tampered[offset] ^= 1;
    await assert.rejects(openMedia(tampered, a.sha256, a.key, binding));
    await assert.rejects(openMedia(tampered, hash(tampered), a.key, binding));
  }
  const wrongKey = a.key.slice(); wrongKey[0] ^= 1;
  await assert.rejects(openMedia(a.bytes, a.sha256, wrongKey, binding));
  await assert.rejects(openMedia(a.bytes, a.sha256, a.key, { ...binding, object: "claim_" + "34".repeat(32) }));
  await assert.rejects(openMedia(a.bytes, a.sha256, a.key, { ...binding, tenant: "afee9b29-1706-5590-bbbf-e58df8945ac1" }));
});
test("media refuses malformed envelopes, addresses, bindings and oversized payloads", async () => {
  const a = await sealMedia(input, binding);
  for (const bytes of [new Uint8Array(), a.bytes.slice(0,32), new Uint8Array(MEDIA_STORED_MAX+1)])
    await assert.rejects(openMedia(bytes, a.sha256, a.key, binding));
  const version = a.bytes.slice(); version[3] = 2;
  await assert.rejects(openMedia(version, hash(version), a.key, binding));
  for (const address of ["", "a".repeat(63), a.sha256.toUpperCase()])
    await assert.rejects(openMedia(a.bytes, address, a.key, binding));
  for (const key of [new Uint8Array(31), new Uint8Array(33)])
    await assert.rejects(openMedia(a.bytes, a.sha256, key, binding));
  for (const bad of [{ ...binding, tenant: "bad" }, { ...binding, tenant: "00000000-0000-0000-0000-000000000000" }, { ...binding, object: "unscoped" }])
    await assert.rejects(sealMedia(input, bad));
  await assert.rejects(sealMedia(new Uint8Array(), binding));
  await assert.rejects(sealMedia(new Uint8Array(MEDIA_PLAIN_MAX+1), binding));
  assert.equal(MEDIA_PLAIN_MAX+32, MEDIA_STORED_MAX);
});
test("media snapshots caller arrays and binding before yielding", async () => {
  const source = input.slice(), context = { ...binding };
  const pending = sealMedia(source, context);
  source.fill(99); context.object = "claim_" + "56".repeat(32);
  const a = await pending;
  const bytes = a.bytes.slice(), key = a.key.slice(), readContext = { ...binding };
  const opening = openMedia(bytes, a.sha256, key, readContext);
  bytes.fill(0); key.fill(0); readContext.tenant = "bad";
  assert.deepEqual(await opening, input);
});
