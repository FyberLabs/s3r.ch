import assert from "node:assert/strict";
import test from "node:test";
import wallet from "./vectors/forum-wallet-link.json";
import witnesses from "./vectors/forum-witness.json";
import revoke from "./vectors/forum-revoke.json";
import { createStartupWalletResolver, type StartupWalletSource } from "./startup-wallet-resolution";
import type { ForumRecoverySnapshot } from "./forum-recovery-history";
import type { ForumWitnessKey } from "./forum-witness-verification";
const link = wallet.wallet.input;
const at = link.issuedAt + 10000;
const trust = { keys: witnesses.keys as ForumWitnessKey[], policy: { allowedDomains: ["s3r.ch"], allowedUris: ["https://s3r.ch/identity/link"], allowedChainIds: ["1"] }, pinnedIssuers: [] };
const snapshot = (links: unknown[] = [link]): ForumRecoverySnapshot => ({ completeThrough: at, links,
  accounts: [{ principal: link.principal, rotations: [], genesisEpubBindings: [], revocations: [] }] });
const resolve = (value: ForumRecoverySnapshot | null, address = link.address) => createStartupWalletResolver({ read: async () => value }, trust, () => at)(address);

test("unique verified binding exports only public fields and performs one read", async () => {
  let reads = 0;
  const source: StartupWalletSource = { read: async (address, now) => { reads++; assert.equal(address, link.address); assert.equal(now, at); return snapshot([link, structuredClone(link)]); } };
  assert.deepEqual(await createStartupWalletResolver(source, trust, () => at)(link.address), { ok: true,
    binding: { wallet: link.address, principal: link.principal, sea_public_key: link.principal, evaluated_at: at } });
  assert.equal(reads, 1);
});

test("missing source, empty candidates, missing history, forged and revoked evidence refuse", async () => {
  assert.deepEqual(await createStartupWalletResolver(null, trust, () => at)(link.address), { ok: false, reason: "source-unavailable" });
  assert.deepEqual(await resolve(null), { ok: false, reason: "source-unavailable" });
  assert.deepEqual(await resolve(snapshot([])), { ok: false, reason: "no-account" });
  assert.deepEqual(await resolve({ ...snapshot(), accounts: [] }), { ok: false, reason: "missing-history" });
  assert.deepEqual(await resolve(snapshot([{ ...link, keySig: "forged" }])), { ok: false, reason: "invalid-evidence" });
  const base = snapshot(); const revoked = { ...base, accounts: [{ ...base.accounts[0], revocations: [revoke.revoke.input] }] };
  assert.deepEqual(await resolve(revoked), { ok: false, reason: "no-account" });
});

test("stale, oversized, malformed and conflicting histories refuse", async () => {
  assert.deepEqual(await resolve({ ...snapshot(), completeThrough: at - 1 }), { ok: false, reason: "stale" });
  assert.deepEqual(await resolve(snapshot(new Array(1025).fill(link))), { ok: false, reason: "invalid-evidence" });
  assert.deepEqual(await resolve(snapshot([null])), { ok: false, reason: "invalid-evidence" });
  const conflicting = snapshot();
  assert.deepEqual(await resolve({ ...conflicting, accounts: [...conflicting.accounts, ...conflicting.accounts] }), { ok: false, reason: "missing-history" });
  let now = at;
  const resolver = createStartupWalletResolver({ read: async () => { now++; return snapshot(); } }, trust, () => now);
  assert.deepEqual(await resolver(link.address), { ok: false, reason: "stale" });
});

test("abort, source errors and invalid address expose no source details", async () => {
  const source = { read: async () => { throw Error("sensitive source internals"); } };
  const resolver = createStartupWalletResolver(source, trust, () => at);
  assert.deepEqual(await resolver(link.address), { ok: false, reason: "source-unavailable" });
  assert.deepEqual(await resolver("not-a-wallet"), { ok: false, reason: "bad-input" });
  assert.deepEqual(await resolver(link.address, AbortSignal.abort()), { ok: false, reason: "source-unavailable" });
});

test("two eligible accounts refuse even when one link is newer", async () => {
  const { p256 } = await import("@noble/curves/nist.js");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createHash } = await import("node:crypto");
  const { parseForumWalletLinkRecord } = await import("./forum-wallet-link-record");
  const account = privateKeyToAccount(("0x" + "0".repeat(63) + "4") as `0x${string}`);
  const secret = new Uint8Array(32); secret[31] = 2;
  const witnessSecret = new Uint8Array(32); witnessSecret[31] = 7;
  const pub = p256.getPublicKey(witnessSecret, false);
  const b64 = (v: string | Uint8Array) => Buffer.from(v).toString("base64url");
  const witnessKey: ForumWitnessKey = { kid: "test", kty: "EC", crv: "P-256", x: b64(pub.slice(1,33)), y: b64(pub.slice(33)), notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER };
  const row = structuredClone(link); row.nonce = "newerNonce123"; row.issuedAt++;
  const identity = p256.getPublicKey(secret, false);
  row.principal = b64(identity.slice(1,33)) + "." + b64(identity.slice(33));
  const bytes = parseForumWalletLinkRecord(row)!.bytes;
  const id = createHash("sha256").update(bytes).digest("hex");
  row.keySig = b64(p256.sign(bytes, secret, { prehash: true, format: "compact" }));
  row.siwe.message = link.siwe.message.replace(wallet.wallet.linkId, id).replace(link.nonce, row.nonce).replace("2023-11-14T22:13:20Z", new Date(row.issuedAt * 1000).toISOString().replace(".000Z", "Z"));
  row.siwe.signature = await account.signMessage({ message: row.siwe.message });
  const msg = b64(JSON.stringify({ alg: "ES256", kid: "test" })) + "." + b64(JSON.stringify({ typ: "sociacl-wallet-attest-v1", principal: row.principal, linkId: id, iat: row.issuedAt, exp: row.issuedAt + 600 }));
  row.attest = msg + "." + b64(p256.sign(new TextEncoder().encode(msg), witnessSecret, { prehash: true, format: "compact" }));
  const value = snapshot([link, row]);
  const full = { ...value, accounts: [...value.accounts, { principal: row.principal, rotations: [], genesisEpubBindings: [], revocations: [] }] };
  const resolver = createStartupWalletResolver({ read: async () => full }, { ...trust, keys: [...trust.keys, witnessKey] }, () => at);
  assert.deepEqual(await resolver(link.address), { ok: false, reason: "multiple-accounts" });
});
