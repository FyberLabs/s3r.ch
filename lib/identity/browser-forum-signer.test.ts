import assert from "node:assert/strict";
import test from "node:test";
import vector from "./vectors/forums.json";
import type { SeaPair } from "./sea";
import type { MeshKeyRecord } from "./idb";
import { observeBrowserForumSigner, publishBrowserForumRecord } from "./browser-forum-signer";
const address = "0x0000000000000000000000000000000000000001";
const pair: SeaPair = { pub: vector.seaPubkey, priv: "private-fixture", epub: "public-encryption-fixture", epriv: "private-encryption-fixture" };
const nextPair = { ...pair, pub: vector.secondPubkey };
const record = { address, seaPub: pair.pub, walletSignature: "signature", signedPayload: "payload", seaPair: pair };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(held: SeaPair | null = null) {
  let complete!: (record: MeshKeyRecord | null) => void, fail!: (error: Error) => void;
  const reading = new Promise<MeshKeyRecord | null>((resolve, reject) => { complete = resolve; fail = reject; });
  let listener: ((address: string, pair: SeaPair | null) => void) | undefined;
  let remembered = 0, stopped = 0, reads = 0;
  const source = {
    read: async () => { reads++; return reading; }, unlocked: () => held,
    remember: (_address: string, value: SeaPair) => { remembered++; held = value; listener?.(address, value); },
    subscribe: (value: NonNullable<typeof listener>) => { listener = value; return () => { stopped++; listener = undefined; }; },
  };
  return { source, complete, fail, emit(value: SeaPair | null, heard = address) { held = value; listener?.(heard, value); },
    counts: () => ({ remembered, stopped, reads }) };
}

test("plaintext loading lives in the identity adapter and stop drops the held signer", async () => {
  const f = fixture(), heard: (string | null)[] = [];
  const signer = observeBrowserForumSigner(address, () => true, pub => heard.push(pub), f.source);
  assert.equal(signer.current(), null); assert.deepEqual(heard, [null]);
  f.complete(record); await settle();
  assert.equal(signer.current(), pair); assert.equal(heard.at(-1), pair.pub);
  assert.equal(f.counts().remembered, 1);
  signer.stop(); signer.stop();
  assert.equal(signer.current(), null); assert.equal(f.counts().stopped, 1);
});

test("a lock during an earlier disk read cannot restore plaintext signing material", async () => {
  const f = fixture(pair);
  const signer = observeBrowserForumSigner(address, () => true, () => {}, f.source);
  assert.equal(signer.current(), pair);
  f.emit(null); assert.equal(signer.current(), null);
  f.complete(record); await settle();
  assert.equal(signer.current(), null); assert.equal(f.counts().remembered, 0);
  signer.stop();
});

test("new unlock wins over late disk success or failure", async () => {
  for (const fails of [false, true]) {
    const f = fixture(pair);
    const signer = observeBrowserForumSigner(address, () => true, () => {}, f.source);
    f.emit(nextPair);
    if (fails) f.fail(Error("private")); else f.complete(record);
    await settle();
    assert.equal(signer.current(), nextPair); assert.equal(f.counts().remembered, 0);
    signer.stop();
  }
});

test("disposed account reads and unrelated unlock events cannot replace a signer", async () => {
  const f = fixture(pair), heard: (string | null)[] = [];
  const signer = observeBrowserForumSigner(address, () => true, pub => heard.push(pub), f.source);
  f.emit(nextPair, "other"); assert.equal(signer.current(), pair);
  signer.stop(); const before = heard.length;
  f.complete(record); await settle();
  assert.equal(signer.current(), null); assert.equal(heard.length, before); assert.equal(f.counts().remembered, 0);
});

test("missing session, disallowed keys and read failure do not expose a signer", async () => {
  const none = fixture();
  const empty = observeBrowserForumSigner(null, () => true, () => {}, none.source);
  await settle(); assert.equal(none.counts().reads, 0); assert.equal(empty.current(), null); empty.stop();
  for (const fail of [false, true]) {
    const f = fixture(pair), heard: (string | null)[] = [];
    const signer = observeBrowserForumSigner(address, () => false, pub => heard.push(pub), f.source);
    if (fail) f.fail(Error("private")); else f.complete(record);
    await settle(); assert.equal(signer.current(), null); assert.ok(heard.every(value => value === null));
    assert.equal(f.counts().remembered, 0); signer.stop();
  }
});

test("a wrapped key can expose only its public hint until explicitly unlocked", async () => {
  const f = fixture(), heard: (string | null)[] = [];
  const signer = observeBrowserForumSigner(address, () => true, pub => heard.push(pub), f.source);
  f.complete({ address, seaPub: pair.pub, walletSignature: "signature", signedPayload: "payload", wrap: {} } as MeshKeyRecord);
  await settle(); assert.equal(signer.current(), null); assert.equal(heard.at(-1), pair.pub);
  f.emit(pair); assert.equal(signer.current(), pair); signer.stop();
});

test("publishing rechecks signer, authority and permission after asynchronous signing", async () => {
  for (const changed of ["pair", "authority", "permission", "none"]) {
    let current: SeaPair | null = pair, key: string | null = pair.pub, allowed = true, puts = 0;
    let finish!: (value: string) => void;
    const signing = new Promise<string>(resolve => { finish = resolve; });
    const pending = publishBrowserForumRecord({ live: true, writer: pair.pub, record: { body: "fixture" },
      pair: () => current, writerKey: () => key, authorized: () => allowed,
      sign: async () => signing, put: value => { puts++; assert.equal(value.sig, "SEA-signed"); return true; } });
    if (changed === "pair") current = nextPair;
    if (changed === "authority") key = null;
    if (changed === "permission") allowed = false;
    finish("SEA-signed");
    assert.equal(await pending, changed === "none" ? "signed" : "denied");
    assert.equal(puts, changed === "none" ? 1 : 0);
  }
});

test("preview, missing signer and changed writer key never sign; offline dispatch remains offline", async () => {
  const base = { live: true, writer: pair.pub, record: {}, pair: () => pair, writerKey: () => pair.pub,
    authorized: () => true, sign: async () => "SEA-signed", put: () => false };
  assert.equal(await publishBrowserForumRecord(base), "offline");
  for (const overrides of [{ live: false }, { pair: () => null }, { writerKey: () => null }]) {
    assert.equal(await publishBrowserForumRecord({ ...base, ...overrides, sign: async () => { assert.fail("must not sign"); } }), "local");
  }
});


test("a lock raised by a key observer during remember is not overwritten", async () => {
  const f = fixture();
  const source = { ...f.source, remember(address: string, value: SeaPair) {
    f.source.remember(address, value); f.emit(null);
  } };
  const signer = observeBrowserForumSigner(address, () => true, () => {}, source);
  f.complete(record); await settle();
  assert.equal(signer.current(), null); signer.stop();
});


test("the default signer produces a verifiable SEA signature without sending private key fields", async () => {
  const { createRequire } = await import("node:module");
  const sea = createRequire(import.meta.url)("gun/sea");
  const realPair: SeaPair = await sea.pair();
  const record = { body: "unit contract" };
  let signed: string | undefined;
  const result = await publishBrowserForumRecord({ live: true, record, writer: realPair.pub,
    pair: () => realPair, writerKey: () => realPair.pub, authorized: () => true,
    put: value => { assert.deepEqual(Object.keys(value).sort(), ["body", "sig"]); signed = value.sig; return true; } });
  assert.equal(result, "signed");
  assert.deepEqual(await sea.verify(signed, realPair.pub), record);
});
