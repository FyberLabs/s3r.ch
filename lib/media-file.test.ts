import test from "node:test";
import assert from "node:assert/strict";
import { sealMediaFile, openMediaFile } from "./media-file";
import { MEDIA_PLAIN_MAX } from "./media-crypto";
import { sealMediaForReaders } from "./media-reader-wraps";
// Public SociACL encrypted-discovery/sea-fixture.json test keys, never credentials.
const pub = "YP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Y.eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk";
const epub = "EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c";
const epriv = "6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8";
const object = "item_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const binding = { tenant: "11111111-1111-4111-8111-111111111111", object };
const expected = { epoch: 3, object, revisionId: "a".repeat(64) };
const reader = { account: pub, pub, identityPub: pub, epub };
const plain = new TextEncoder().encode("private media fixture");


const metadata = { name: "private holiday.png", mediaType: "image/png" };
const seal = (bytes = plain, info = metadata) => sealMediaFile(bytes, info, binding, expected, [reader], [pub]);
const open = (sealed: Awaited<ReturnType<typeof seal>>) => openMediaFile(sealed.bytes, sealed.sha256, sealed.wraps[0], epriv, epub, binding, expected);

test("file description and bytes are private, authenticated, and captured before awaits", async () => {
  const bytes = plain.slice(), info = { ...metadata };
  const pending = seal(bytes, info); bytes.fill(0); info.name = "changed.png";
  const sealed = await pending;
  assert.deepEqual(Object.keys(sealed).sort(), ["bytes", "sha256", "wraps"]);
  assert.equal(new TextDecoder().decode(sealed.bytes).includes(metadata.name), false);
  const opened = await open(sealed);
  assert.deepEqual(opened.description, metadata); assert.deepEqual(opened.bytes, plain);
  assert.equal(Object.isFrozen(opened.description), true);
  sealed.bytes[20] ^= 1;
  await assert.rejects(open(sealed));
});

test("executable types, paths, control characters, accessors and oversized names are refused", async () => {
  for (const name of ["", "..", "x/y", "x\\y", " x", "x ", "x\0", "x\u202e", "\ud800", "界".repeat(86)])
    await assert.rejects(seal(plain, { ...metadata, name }));
  for (const mediaType of ["text/html", "image/svg+xml", "image/png; charset=utf-8", "IMAGE/PNG", "application/octet-stream"])
    await assert.rejects(seal(plain, { ...metadata, mediaType }));
  let called = false;
  const accessor = { get name() { called = true; return "x"; }, mediaType: "image/png" };
  await assert.rejects(seal(plain, accessor)); assert.equal(called, false);
  for (const value of [null, [], { ...metadata, extra: true }, { name: "x" }])
    await assert.rejects(seal(plain, value as typeof metadata));
  await assert.rejects(seal(new Uint8Array()));
});

function packed(info: unknown, content = plain) {
  const header = new TextEncoder().encode(JSON.stringify(info));
  const bytes = new Uint8Array(8 + header.length + content.length);
  bytes.set([0x73, 0x33, 0x66, 1]); new DataView(bytes.buffer).setUint32(4, header.length);
  bytes.set(header, 8); bytes.set(content, 8 + header.length); return bytes;
}
test("authenticated but malformed or mismatched descriptors never become a file", async () => {
  const valid = { version: 1, ...metadata, length: plain.length };
  const oversized = packed({ ...valid, name: "x".repeat(1200) });
  const invalidUtf8 = packed(valid); invalidUtf8[8] = 255;
  const badHeader = packed(valid); badHeader[3] = 2;
  const badLength = packed(valid); new DataView(badLength.buffer).setUint32(4, 0xffffffff);
  const emptyHeader = packed(valid); new DataView(emptyHeader.buffer).setUint32(4, 0);
  for (const bytes of [plain, badHeader, badLength, emptyHeader, oversized, invalidUtf8,
    packed(null), packed([]), packed({ ...valid, version: 2 }), packed({ ...valid, length: 1 }),
    packed({ ...valid, extra: true }), packed({ ...valid, mediaType: "text/html" }),
    packed({ ...valid, length: 0 }, new Uint8Array())]) {
    const sealed = await sealMediaForReaders(bytes, binding, expected, [reader], [pub]);
    await assert.rejects(open(sealed));
  }
});

test("media families roundtrip while grant and tenant binding remain required", async () => {
  for (const mediaType of ["image/jpeg", "audio/ogg", "video/mp4"]) {
    const sealed = await seal(plain, { name: "private file", mediaType });
    assert.equal((await open(sealed)).description.mediaType, mediaType);
    await assert.rejects(openMediaFile(sealed.bytes, sealed.sha256, sealed.wraps[0], epriv, epub,
      { ...binding, tenant: "22222222-2222-4222-8222-222222222222" }, expected));
    await assert.rejects(openMediaFile(sealed.bytes, sealed.sha256, sealed.wraps[0], epriv, epub,
      binding, { ...expected, epoch: 4 }));
  }
});

test("the encrypted descriptor overhead counts against the provider byte limit", async () => {
  const bytes = new Uint8Array(MEDIA_PLAIN_MAX);
  await assert.rejects(seal(bytes));
  await assert.rejects(seal(bytes.subarray(0, MEDIA_PLAIN_MAX - 8)));
  await assert.rejects(sealMediaFile(plain, metadata, binding, expected, [], []));
});
