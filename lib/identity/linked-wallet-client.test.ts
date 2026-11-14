import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { decodeJwt } from "jose";
import { createLinkedWalletClient, type LinkedWalletSelection } from "./linked-wallet-client";
import { linkedSessionFixture } from "../../scripts/fixtures/linked-session";

const wallet = privateKeyToAccount(("0x" + "0".repeat(63) + "4") as `0x${string}`);
async function setup() {
  const fixture = await linkedSessionFixture("wallet");
  let current: LinkedWalletSelection | null = { address: wallet.address, chainId: "1", walletRevision: 0, sessionRevision: 0 };
  let now = 200;
  let signatures = 0, exchanges = 0, mutate: (token: string) => string = token => token;
  let unavailable = false, afterSign = () => {}, beforeChallenge = () => {}, afterExchange = () => {};
  const client = createLinkedWalletClient({ origin: "https://s3r.ch", clock: () => now, current: () => current,
    signMessage: async message => { signatures++; const signature = await wallet.signMessage({ message }); afterSign(); return signature; },
    fetch: async (url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(init!.credentials, "same-origin"); assert.equal(init!.redirect, "error");
      if (String(url).endsWith("linked-challenge")) {
        beforeChallenge(); if (unavailable) return Response.json({}, { status: 503 });
        const challenge = await fixture.sessions.linkedChallenge(body.credential);
        return Response.json({ challenge: mutate(challenge!) });
      }
      exchanges++; const result = await fixture.sessions.exchangeLinked(body.challenge, body.proof); afterExchange();
      return Response.json({ ok: !!result }, { status: result ? 200 : 403 });
    } });
  return { setTime: (value: number) => { now = value; }, fixture, client, counts: () => [signatures, exchanges], select: (change: Partial<LinkedWalletSelection>) => { current = { ...current!, ...change }; },
    mutate: (fn: typeof mutate) => { mutate = fn; }, unavailable: () => { unavailable = true; },
    afterSign: (fn: () => void) => { afterSign = fn; }, beforeChallenge: (fn: () => void) => { beforeChallenge = fn; }, afterExchange: (fn: () => void) => { afterExchange = fn; } };
}
test("wallet SIWE challenge hash, nonce and issuer URI admit through real issuer", async () => {
  const s = await setup(); assert.equal(await s.client.signIn(), true); assert.deepEqual(s.counts(), [1, 1]);
});
test("unavailable source refuses before wallet signing", async () => {
  const s = await setup(); s.unavailable(); assert.equal(await s.client.signIn(), false); assert.deepEqual(s.counts(), [0, 0]);
});
test("closed signing intent refuses malformed, wrong-scope and expired challenges", async () => {
  const mutations = [
    { aud: "https://evil.example" }, { iss: "https://evil.example" }, { exp: 200 }, { iat: 201, exp: 261 },
    { credential: { kind: "wallet", address: "0x" + "1".repeat(40) } }, { credential: { kind: "oidc" } },
    { linkId: "bad" }, { sub: "invalid" }, { jti: "bad" }, { extra: true },
  ];
  for (const changes of mutations) {
    const s = await setup(); s.mutate(token => { const parts = token.split("."); parts[1] = Buffer.from(JSON.stringify({ ...decodeJwt(token), ...changes })).toString("base64url"); return parts.join("."); });
    assert.equal(await s.client.signIn(), false); assert.deepEqual(s.counts(), [0, 0]);
  }
});
test("wallet/chain/session revisions fence changes before and after signing", async () => {
  for (const change of [{ chainId: "2" }, { walletRevision: 2 }, { sessionRevision: 1 }]) {
    const s = await setup(); s.beforeChallenge(() => s.select(change));
    assert.equal(await s.client.signIn(), false); assert.deepEqual(s.counts(), [0, 0]);
    const t = await setup(); t.afterSign(() => t.select(change));
    assert.equal(await t.client.signIn(), false); assert.deepEqual(t.counts(), [1, 0]);
  }
});
test("cancellation and stale exchange never publish client success", async () => {
  const s = await setup(); s.afterSign(() => s.client.cancel()); assert.equal(await s.client.signIn(), false); assert.deepEqual(s.counts(), [1, 0]);
  const t = await setup(); t.afterExchange(() => t.select({ sessionRevision: 1 })); assert.equal(await t.client.signIn(), false);
});
test("aborts uncooperative pending request, rejects concurrent attempt and can retry", async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let signing = 0;
  const client = createLinkedWalletClient({ origin: "https://s3r.ch", current: () => ({ address: wallet.address, chainId: "1", walletRevision: 0, sessionRevision: 0 }), signMessage: async () => { signing++; return ""; },
    fetch: async () => { started(); return new Promise<Response>(() => {}); } });
  const pending = client.signIn(); await ready; assert.equal(await client.signIn(), false); client.cancel(); assert.equal(await pending, false); assert.equal(signing, 0);
  const abort = new AbortController(); abort.abort(); assert.equal(await client.signIn(abort.signal), false);
});
test("oversized responses never reach wallet", async () => {
  let signing = 0;
  const client = createLinkedWalletClient({ origin: "https://s3r.ch", current: () => ({ address: wallet.address, chainId: "1", walletRevision: 0, sessionRevision: 0 }), signMessage: async () => { signing++; return ""; }, fetch: async () => Response.json({ challenge: "x".repeat(9000) }) });
  assert.equal(await client.signIn(), false); assert.equal(signing, 0);
});

test("delayed challenge and signer expiry stop before signing or exchanging", async () => {
  const s = await setup(); s.beforeChallenge(() => s.setTime(260));
  assert.equal(await s.client.signIn(), false); assert.deepEqual(s.counts(), [0, 0]);
  const t = await setup(); t.afterSign(() => t.setTime(260));
  assert.equal(await t.client.signIn(), false); assert.deepEqual(t.counts(), [1, 0]);
});
