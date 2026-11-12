import test from "node:test";
import assert from "node:assert/strict";
import { sealMediaForReaders, openMediaForReader } from "./media-reader-wraps";
// Public SociACL encrypted-discovery/sea-fixture.json test keys, never credentials.
const pub = "YP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Y.eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk";
const epub = "EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c";
const epriv = "6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8";
const object = "item_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const binding = { tenant: "11111111-1111-4111-8111-111111111111", object };
const expected = { epoch: 3, object, revisionId: "a".repeat(64) };
const reader = { account: pub, pub, identityPub: pub, epub };
const plain = new TextEncoder().encode("private media fixture");

test("media ciphertext and private wraps roundtrip without returning the raw key", async () => {
  const sealed = await sealMediaForReaders(plain, binding, expected, [reader], [pub]);
  assert.deepEqual(Object.keys(sealed).sort(), ["bytes", "sha256", "wraps"]);
  assert.notDeepEqual(sealed.bytes, plain);
  assert.deepEqual(await openMediaForReader(sealed.bytes, sealed.sha256, sealed.wraps[0], epriv, epub, binding, expected), plain);
  const second = await sealMediaForReaders(plain, binding, expected, [reader], [pub]);
  assert.notEqual(second.sha256, sealed.sha256);
});

test("a current grant context and the original tenant binding are required", async () => {
  const sealed = await sealMediaForReaders(plain, binding, expected, [reader], [pub]);
  const open = (address = binding, context = expected, digest = sealed.sha256) =>
    openMediaForReader(sealed.bytes, digest, sealed.wraps[0], epriv, epub, address, context);
  await assert.rejects(open(binding, { ...expected, epoch: 4 }));
  await assert.rejects(open(binding, { ...expected, revisionId: "b".repeat(64) }));
  await assert.rejects(open({ ...binding, tenant: "22222222-2222-4222-8222-222222222222" }));
  await assert.rejects(open(binding, expected, "0".repeat(64)));
  await assert.rejects(sealMediaForReaders(plain, binding, expected, [reader], []));
  await assert.rejects(sealMediaForReaders(plain, binding, expected, [], []));
  await assert.rejects(sealMediaForReaders(plain, binding, { ...expected, object: object.replace(/1$/, "2") }, [reader], [pub]));
});

test("recipient and epoch inputs are captured before asynchronous encryption", async () => {
  const mutable = { ...reader }, context = { ...expected }, address = { ...binding };
  const pending = sealMediaForReaders(plain, address, context, [mutable], [pub]);
  mutable.epub = pub; context.epoch++; address.tenant = "22222222-2222-4222-8222-222222222222";
  const sealed = await pending;
  assert.equal(sealed.wraps[0].targetId, epub);
  assert.deepEqual(await openMediaForReader(sealed.bytes, sealed.sha256, sealed.wraps[0], epriv, epub, binding, expected), plain);
});

test("accessors, sparse lists, oversized lists and malformed fields are refused", async () => {
  let called = 0;
  const poison = { ...reader }; Object.defineProperty(poison, "epub", { get() { called++; return epub; } });
  await assert.rejects(sealMediaForReaders(plain, binding, expected, [poison], [pub]));
  await assert.rejects(sealMediaForReaders(plain, binding, expected, new Array(1), [pub]));
  await assert.rejects(sealMediaForReaders(plain, binding, expected, new Array(65).fill(reader), [pub]));
  await assert.rejects(sealMediaForReaders(plain, binding, { ...expected, epoch: -0 }, [reader], [pub]));
  assert.equal(called, 0);
});


test("a valid wrap cannot open another envelope for the same object", async () => {
  const first = await sealMediaForReaders(plain, binding, expected, [reader], [pub]);
  const second = await sealMediaForReaders(plain, binding, expected, [reader], [pub]);
  await assert.rejects(openMediaForReader(second.bytes, second.sha256, first.wraps[0], epriv, epub, binding, expected));
  const corrupted = new Uint8Array(first.bytes);
  corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(openMediaForReader(corrupted, first.sha256, first.wraps[0], epriv, epub, binding, expected));
});


test("malformed grant material fails before media can be opened or handed off", async () => {
  const invalid = [null, [], { ...binding, extra: true }, { tenant: binding.tenant }, { ...binding, tenant: 1 }];
  for (const address of invalid) {
    await assert.rejects(sealMediaForReaders(plain, address as never, expected, [reader], [pub]));
  }
  for (const context of [{ ...expected, epoch: NaN }, { ...expected, revisionId: "invalid" }, { ...expected, extra: true }]) {
    await assert.rejects(sealMediaForReaders(plain, binding, context, [reader], [pub]));
  }
  await assert.rejects(sealMediaForReaders(plain, binding, expected, [{ ...reader, epub: 1 } as never], [pub]));
  await assert.rejects(sealMediaForReaders(plain, binding, expected, [reader], [1 as never]));
  await assert.rejects(sealMediaForReaders(plain, binding, expected, null as never, [pub]));
  const sealed = await sealMediaForReaders(plain, binding, expected, [reader], [pub]);
  await assert.rejects(openMediaForReader(sealed.bytes, sealed.sha256, sealed.wraps[0], "invalid", epub, binding, expected));
});
