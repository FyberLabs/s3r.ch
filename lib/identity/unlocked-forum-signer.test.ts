import assert from "node:assert/strict";
import test from "node:test";
import vector from "./vectors/forums.json";
import { observeUnlockedForumSigner, publishBrowserForumRecord } from "./browser-forum-signer";
import { forgetUnlockedMeshPair, rememberUnlockedMeshPair } from "./unlocked-mesh";
const pair = { pub: vector.seaPubkey, priv: "private", epub: "encryption", epriv: "private-encryption" };

test("signer selects SEA possession without a wallet session and requires its connected key", () => {
  forgetUnlockedMeshPair();
  const heard: Array<string | null> = [];
  const signer = observeUnlockedForumSigner(pub => pub === pair.pub, pub => heard.push(pub));
  assert.equal(signer.current(), null);
  rememberUnlockedMeshPair("saved-credential", pair);
  assert.equal(signer.current()?.pub, pair.pub);
  assert.equal(signer.current(), signer.current());
  assert.notEqual(signer.current(), pair);
  rememberUnlockedMeshPair("other-credential", { ...pair, pub: vector.secondPubkey });
  assert.equal(signer.current(), null);
  forgetUnlockedMeshPair("saved-credential");
  assert.equal(signer.current(), null);
  assert.equal(heard.at(-1), null);
  forgetUnlockedMeshPair();
  rememberUnlockedMeshPair("saved-credential", pair);
  assert.equal(signer.current()?.pub, pair.pub);
  signer.stop(); signer.stop();
  assert.equal(signer.current(), null);
  const count = heard.length;
  forgetUnlockedMeshPair();
  assert.equal(heard.length, count);
});

test("same-key re-unlock and ambiguity revoke an in-flight publication", async () => {
  for (const change of [() => forgetUnlockedMeshPair(),
    () => rememberUnlockedMeshPair("saved", { ...pair }),
    () => rememberUnlockedMeshPair("other", { ...pair, pub: vector.secondPubkey })]) {
    forgetUnlockedMeshPair(); rememberUnlockedMeshPair("saved", pair);
    const signer = observeUnlockedForumSigner(pub => pub === pair.pub, () => {});
    let puts = 0;
    const result = await publishBrowserForumRecord({ live: true, record: { text: "private fixture" },
      writer: pair.pub, pair: signer.current, writerKey: () => pair.pub, authorized: () => true,
      sign: async () => { change(); return "signature"; }, put: () => { puts++; return true; } });
    assert.notEqual(result, "signed"); assert.equal(puts, 0);
    signer.stop(); forgetUnlockedMeshPair();
  }
});

test("unchanged unlocked identity still needs current permission", async () => {
  forgetUnlockedMeshPair(); rememberUnlockedMeshPair("saved", pair);
  const signer = observeUnlockedForumSigner(() => true, () => {});
  let allowed = true, puts = 0;
  const input = { live: true, record: { text: "fixture" }, writer: pair.pub, pair: signer.current,
    writerKey: () => pair.pub, authorized: () => allowed, sign: async () => "signature",
    put: () => { puts++; return true; } };
  assert.equal(await publishBrowserForumRecord(input), "signed");
  allowed = false;
  assert.notEqual(await publishBrowserForumRecord(input), "signed");
  assert.equal(puts, 1);
  signer.stop(); forgetUnlockedMeshPair();
});
