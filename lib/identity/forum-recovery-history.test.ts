import assert from "node:assert/strict";
import test from "node:test";
import vectors from "./vectors/forum-recovery-history.json";
import { resolveForumRecoveryHistory, type ForumRecoverySnapshot } from "./forum-recovery-history";
import type { ForumWitnessKey } from "./forum-witness-verification";
import type { ForumSiwePolicy } from "./forum-siwe";

type Vector = { name: string; accept: boolean; canonical?: string; reason?: string; rotations: number[];
  links?: (string | number)[][]; revocations?: number[]; genesisEpubBindings?: number[];
  histories?: (string | number[])[][]; genesis?: string; now?: number; currentEpub?: string | null;
  policy?: ForumSiwePolicy; pinnedIss?: string[]; jwks?: { keys: unknown[] } };
const cases = vectors.cases as Vector[];
const ctx = vectors.context;
const records: unknown[] = vectors.records;
function setup(v: Vector) {
  const owner = v.genesis ?? ctx.genesis, at = v.now ?? ctx.now;
  const histories = new Map((v.histories ?? []).map(([p, rows]) => [p as string, (rows as number[]).map(i => records[i])]));
  const input: ForumRecoverySnapshot = { completeThrough: at,
    links: (v.links ?? ctx.links).map(([, i]) => records[i as number]),
    accounts: [...new Set([...ctx.authenticatedAccounts, owner])].map(principal => ({ principal,
      rotations: principal === owner ? v.rotations.map(i => records[i]) : histories.get(principal) ?? [],
      genesisEpubBindings: principal === owner ? (v.genesisEpubBindings ?? []).map(i => records[i]) : [],
      revocations: (v.revocations ?? []).map(i => records[i]),
    })),
  };
  return { owner, at, input, keys: (v.jwks ?? ctx.jwks).keys as ForumWitnessKey[], policy: v.policy ?? ctx.policy, issuers: v.pinnedIss ?? ctx.pinnedIss };
}
// Deliberate consumer restrictions: authenticated sequence/key-reuse evidence
// denies the entire projection instead of returning the preceding key. Future
// genesis bindings do not enter a projection bound to an earlier instant.
const stricterConflicts = new Set([
  "rotate-v3-epub-reuses-prior-epub", "rotate-v3-epub-reuses-earlier-signing-key",
  "rotate-v3-nextkey-reuses-prior-epub", "probe-epub-reuse-across-rotations",
  "probe-epub-equals-prior-signing-key", "probe-v2-nextkey-reuses-prior-epub",
  "probe-v3-v2-v3-reuses-first-epub", "binding-reused-by-later-next-epub", "probe-genesis-epub-at-seq-2",
]);
for (const v of cases) test(`upstream recovery: ${v.name}`, async () => {
  const { owner, at, input, keys, policy, issuers } = setup(v);
  const result = await resolveForumRecoveryHistory(owner, input, keys, policy, issuers, at);
  const override = stricterConflicts.has(v.name) ? "rotation-conflict" :
    v.name === "sequence-gap" || v.name === "rotated-external-owner-blocks-recovery" ? "missing-history" : null;
  // Upstream's foreign-history case supplies a trusted projection without its
  // OIDC authorizer. This raw-history API must deny until that evidence arrives.
  assert.equal(result.ok, override ? false : v.accept, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.currentKey, v.canonical);
    assert.equal(result.currentEpub, v.name === "binding-clock-skew" ? null : v.currentEpub ?? null);
  } else assert.equal(result.reason, override ?? (v.reason === "too-long" ? "bad-input" : v.reason));
});

import { p256 } from "@noble/curves/nist.js";
import { privateKeyToAccount } from "viem/accounts";
import { parseForumWalletLinkRecord } from "./forum-wallet-link-record";
import { parseForumRotationCandidate } from "./forum-rotation-record";
import { parseForumRevoke } from "./forum-revocation";
import { recoveryBytes, recoveryId, parseForumRecoveryRecord } from "./forum-recovery-records";
import { checkForumWalletLinkEligibility } from "./forum-wallet-eligibility";
import { createForumKeyResolver } from "./forum-history-adapter";
const b64 = (v: string | Uint8Array) => Buffer.from(v).toString("base64url");
const secret = (n: number) => { const v = new Uint8Array(32); v[31] = n; return v; };
const pub = (n: number) => { const p = p256.getPublicKey(secret(n), false); return b64(p.slice(1, 33)) + "." + b64(p.slice(33)); };
const sign = (bytes: Uint8Array, n: number) => b64(p256.sign(bytes, secret(n), { prehash: true, format: "compact" }));
const [x, y] = pub(7).split(".");
const trust: ForumWitnessKey[] = [{ kid: "test", kty: "EC", crv: "P-256", x, y, notBefore: 0, notAfter: 10000 }];
const witness = (claims: Record<string, unknown>) => {
  const input = b64(JSON.stringify({ alg: "ES256", kid: "test" })) + "." + b64(JSON.stringify(claims));
  return input + "." + sign(new TextEncoder().encode(input), 7);
};
const wallet = privateKeyToAccount(("0x" + "0".repeat(63) + "4") as `0x${string}`);
async function siwe(bytes: Uint8Array, at: number, nonce = "testNonce123") {
  const message = `s3r.ch wants you to sign in with your Ethereum account:\n${wallet.address}\n\nSociACL link: ${await recoveryId(bytes)}\n\nURI: https://s3r.ch/identity/link\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date(at * 1000).toISOString().replace('.000Z', 'Z')}`;
  return { message, signature: await wallet.signMessage({ message }) };
}
async function mintWallet(owner = 1, at = 100, nonce = "testNonce123", key = owner) {
  const row = { v: 1 as const, kind: "wallet" as const, principal: pub(owner), address: wallet.address, issuedAt: at, nonce,
    keySig: "pending", attest: "pending", siwe: { message: "", signature: "0x" + "00".repeat(65) } };
  const bytes = parseForumWalletLinkRecord(row)!.bytes, id = await recoveryId(bytes);
  row.keySig = sign(bytes, key); row.siwe = await siwe(bytes, at, nonce);
  row.attest = witness({ typ: "sociacl-wallet-attest-v1", principal: row.principal, linkId: id, iat: at, exp: at + 600 });
  return { row, id };
}
async function mintOidc(owner = 1, at = 100, key = owner) {
  const row = { v: 1 as const, kind: "oidc" as const, principal: pub(owner), issuedAt: at, nonce: "oidcNonce123", keySig: "pending", attest: "pending",
    cred: { iss: ctx.pinnedIss[0], tenant: "01234567-89ab-cdef-0123-456789abcdef", sub: "test-subject" } };
  const bytes = parseForumRecoveryRecord(row)!.bytes, id = await recoveryId(bytes);
  row.keySig = sign(bytes, key);
  row.attest = witness({ typ: "sociacl-oidc-attest-v1", ...row.cred, principal: row.principal, nonce: row.nonce, iat: at, exp: at + 600 });
  return { row, id };
}
async function mintRotation(link: string, options: { owner?: number; prev?: number; next?: number; at?: number; seq?: number; retained?: string[]; epub?: number; oidc?: boolean } = {}) {
  const { owner = 1, prev = 1, next = 2, at = 120, seq = 1, retained = [link], epub = 9, oidc = false } = options;
  const row = { v: 1 as const, kind: "rotate" as const, principal: pub(owner), prevKey: pub(prev), nextKey: pub(next), nextEpub: pub(epub), issuedAt: at, seq,
    retainedLinks: retained.slice().sort(), nextSig: "pending", attest: "pending",
    authorizer: oidc ? { kind: "oidc-fresh-login" as const, link } : { kind: "wallet" as const, link, siwe: { message: "", signature: "0x" + "00".repeat(65) } } };
  const bytes = parseForumRotationCandidate(row)!.bytes;
  row.nextSig = sign(bytes, next);
  if (row.authorizer.kind === "wallet") row.authorizer.siwe = await siwe(bytes, at);
  row.attest = witness({ typ: oidc ? "sociacl-rotate-attest-v3" : "sociacl-rotate-attest-v4", principal: row.principal, nextKey: row.nextKey,
    nextEpub: row.nextEpub, seq, iat: at, exp: at + 600, auth: row.authorizer.kind, linkId: link, retainedLinks: row.retainedLinks,
    ...(row.authorizer.kind === "wallet" ? { siweHash: await recoveryId(recoveryBytes(["sociacl-siwe-proof-v1", row.authorizer.siwe.message, row.authorizer.siwe.signature])) } : {}) });
  return row;
}
async function mintRevoke(link: string, at: number, key: number, attested: boolean) {
  const row = { v: 1 as const, kind: "revoke" as const, principal: pub(1), issuedAt: at, linkId: link, keySig: "pending", ...(attested ? { attest: "pending" } : {}) };
  const bytes = parseForumRevoke(row)!.bytes; row.keySig = sign(bytes, key);
  if (attested) row.attest = witness({ typ: "sociacl-revoke-attest-v1", principal: row.principal, recordId: await recoveryId(bytes), iat: at, exp: at + 600 });
  return row;
}
function bundle(rotations: readonly unknown[], links: readonly unknown[], revocations: readonly unknown[] = [], bindings: readonly unknown[] = []): ForumRecoverySnapshot {
  return { completeThrough: 200, links, accounts: [{ principal: pub(1), rotations, revocations, genesisEpubBindings: bindings }] };
}
const run = (input: ForumRecoverySnapshot, at = 200) => resolveForumRecoveryHistory(pub(1), input, trust, ctx.policy, ctx.pinnedIss, at);
function denied(result: Awaited<ReturnType<typeof run>>, reason: string) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, reason); }

test("raw snapshot absence, stale completeness, missing lists and duplicate accounts deny", async () => {
  const good = bundle([], []);
  denied(await run({ ...good, completeThrough: 199 }), "missing-history");
  denied(await run({ ...good, accounts: [] }), "missing-history");
  denied(await run({ ...good, accounts: [good.accounts[0], good.accounts[0]] }), "bad-input");
  denied(await run({ ...good, links: undefined } as unknown as ForumRecoverySnapshot), "bad-input");
  for (const at of [NaN, Infinity, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1]) denied(await run(good, at), "bad-input");
  const result = await run(good); assert.ok(result.ok); assert.equal(result.currentKey, pub(1));
});

test("list, aggregate, and policy limits fail without truncation", async () => {
  denied(await run(bundle(new Array(1025), [])), "bad-input");
  denied(await run(bundle([], new Array(1025))), "bad-input");
  const accounts = Array.from({ length: 5 }, (_, i) => ({ principal: pub(i + 1), rotations: new Array(900), revocations: [], genesisEpubBindings: [] }));
  denied(await run({ ...bundle([], []), accounts }), "resource-limit");
  denied(await resolveForumRecoveryHistory(pub(1), bundle([], []), trust, { ...ctx.policy, clockSkewSeconds: 301 }, ctx.pinnedIss, 200), "bad-input");
});

test("async proof verification uses detached records, policies, witnesses and revocations", async () => {
  const w = await mintWallet(), r = await mintRotation(w.id);
  const input = structuredClone(bundle([r], [w.row]));
  const keys = structuredClone(trust), policy = structuredClone(ctx.policy);
  const pending = resolveForumRecoveryHistory(pub(1), input, keys, policy, ctx.pinnedIss, 200);
  (input.links as unknown[]).length = 0; (input.accounts as unknown[]).length = 0;
  keys[0] = { ...keys[0], notAfter: 0 }; policy.allowedDomains.length = 0;
  const result = await pending; assert.ok(result.ok); assert.equal(result.currentKey, pub(2));
  assert.equal(result.provider(pub(1), 201), null); assert.equal(result.provider(pub(2), 200), null);
  assert.ok(Object.isFrozen(result.history.rotations));
  const resolver = createForumKeyResolver((owner, at) => result.provider(owner, at)?.history ?? null);
  assert.equal(resolver(pub(1), 121, 200)?.currentKey, pub(2));
  assert.equal(resolver(pub(1), 121, 201), null);
});

test("own-data snapshots never call accessors", async () => {
  let reads = 0;
  const accessor = { get rotations() { reads++; return []; } };
  denied(await run({ ...bundle([], []), accounts: [accessor] } as unknown as ForumRecoverySnapshot), "bad-input");
  const rows = Object.defineProperty([null], "0", { get() { reads++; return {}; } });
  const result = await run(bundle(rows, [])); assert.ok(result.ok);
  assert.equal(reads, 0); assert.ok(result.diagnostics.some(d => d.reason === "bad-record"));
});

test("newest eligible wallet and equal-time ambiguity deny obsolete authorizers", async () => {
  const old = await mintWallet(), newer = await mintWallet(1, 110, "newNonce123");
  const r = await mintRotation(old.id);
  denied(await run(bundle([r], [old.row, newer.row])), "rotation-conflict");
  const same = await mintWallet(1, 100, "sameNonce123");
  denied(await run(bundle([r], [same.row, old.row])), "rotation-conflict");
});

test("foreign witnessed wallet requires raw history; a forged foreign row cannot veto", async () => {
  const own = await mintWallet(), foreign = await mintWallet(3, 110), r = await mintRotation(own.id);
  denied(await run(bundle([r], [own.row, foreign.row])), "missing-history");
  const forged = { ...foreign.row, attest: "forged" };
  assert.ok((await run(bundle([r], [forged, own.row]))).ok);
  const b = bundle([r], [own.row, foreign.row]);
  denied(await run({ ...b, accounts: [...b.accounts, { principal: pub(3), rotations: [], revocations: [], genesisEpubBindings: [] }] }), "rotation-conflict");
});

test("foreign rotated account is verified from raw OIDC evidence", async () => {
  const own = await mintWallet(), oidc = await mintOidc(3, 90);
  const foreignRotation = await mintRotation(oidc.id, { owner: 3, prev: 3, next: 4, at: 100, oidc: true, retained: [], epub: 10 });
  const foreign = await mintWallet(3, 110, "foreignNonce123", 4);
  const r = await mintRotation(own.id), b = bundle([r], [own.row, oidc.row, foreign.row]);
  denied(await run({ ...b, accounts: [...b.accounts, { principal: pub(3), rotations: [foreignRotation], revocations: [], genesisEpubBindings: [] }] }), "rotation-conflict");
});

test("retained links all require valid evidence and cannot be resurrected", async () => {
  const w = await mintWallet(), o = await mintOidc();
  const r = await mintRotation(w.id, { retained: [w.id, o.id] });
  denied(await run(bundle([r], [w.row])), "missing-history");
  const drop = await mintRotation(w.id, { retained: [w.id] });
  const restore = await mintRotation(w.id, { prev: 2, next: 3, seq: 2, at: 140, epub: 10, retained: [w.id, o.id] });
  denied(await run(bundle([drop, restore], [w.row, o.row])), "missing-history");
});

test("OIDC fallback requires pinned link and exact transition witness; active wallet blocks it", async () => {
  const o = await mintOidc(), w = await mintWallet(), r = await mintRotation(o.id, { oidc: true });
  assert.ok((await run(bundle([r], [o.row]))).ok);
  denied(await run(bundle([r], [o.row, w.row])), "rotation-conflict");
  denied(await resolveForumRecoveryHistory(pub(1), bundle([r], [o.row]), trust, ctx.policy, [], 200), "missing-history");
  const unsigned = await run(bundle([{ ...r, attest: "bad" }], [o.row]));
  assert.ok(unsigned.ok); assert.equal(unsigned.currentKey, pub(1));
});

test("witnessed revokes block recovery; retired-key backdating and current offline revokes cannot rewrite history", async () => {
  const w = await mintWallet(), r = await mintRotation(w.id);
  denied(await run(bundle([r], [w.row], [await mintRevoke(w.id, 110, 1, true)])), "rotation-conflict");
  const offlineOld = await mintRevoke(w.id, 110, 1, false);
  const old = await run(bundle([r], [w.row], [offlineOld])); assert.ok(old.ok);
  assert.ok((await checkForumWalletLinkEligibility(w.row, old.provider, trust, ctx.policy, 200, "present")).ok);
  const offlineCurrent = await mintRevoke(w.id, 130, 2, false);
  const current = await run(bundle([r], [w.row], [offlineCurrent])); assert.ok(current.ok);
  assert.ok((await checkForumWalletLinkEligibility(w.row, current.provider, trust, ctx.policy, 200, "historical")).ok);
  const present = await checkForumWalletLinkEligibility(w.row, current.provider, trust, ctx.policy, 200, "present");
  assert.equal(present.ok, false); if (!present.ok) assert.equal(present.reason, "revoked-link");
  const witnessed = await run(bundle([r], [w.row], [await mintRevoke(w.id, 130, 2, true)])); assert.ok(witnessed.ok);
  const historic = await checkForumWalletLinkEligibility(w.row, witnessed.provider, trust, ctx.policy, 200, "historical");
  assert.equal(historic.ok, false); if (!historic.ok) assert.equal(historic.reason, "revoked-link");
});

test("a witnessed old-key revoke cannot be hidden by a later rotation", async () => {
  const w = await mintWallet(), o = await mintOidc();
  const first = await mintRotation(w.id, { retained: [w.id, o.id] });
  const second = await mintRotation(w.id, { prev: 2, next: 3, seq: 2, at: 150, epub: 10, retained: [w.id, o.id] });
  // A revoked retained OIDC link invalidates the first transition; the resolver
  // cannot return a newer key that would make that old-key signature disappear.
  denied(await run(bundle([second, first], [w.row, o.row], [await mintRevoke(o.id, 110, 1, true)])), "rotation-conflict");
});

test("future rotation does not change historical projection; repeat calls re-evaluate evidence", async () => {
  const w = await mintWallet(), r = await mintRotation(w.id), b = bundle([r], [w.row]);
  const earlier = await run(b, 119); assert.ok(earlier.ok); assert.equal(earlier.currentKey, pub(1));
  const later = await run(b, 120); assert.ok(later.ok); assert.equal(later.currentKey, pub(2));
  assert.equal(earlier.provider(pub(1), 120), null);
  const sibling = await mintRotation(w.id, { next: 3, epub: 10 });
  denied(await run(bundle([r, sibling], [w.row])), "rotation-fork");
});

test("cyclic cross-account recovery dependencies deny without recursive fallback", async () => {
  const own = await mintWallet(), foreign = await mintWallet(3, 110);
  const a = await mintRotation(own.id), b = await mintRotation(foreign.id, { owner: 3, prev: 3, next: 4, epub: 10 });
  const input = bundle([a], [own.row, foreign.row]);
  denied(await run({ ...input, accounts: [...input.accounts, { principal: pub(3), rotations: [b], revocations: [], genesisEpubBindings: [] }] }), "missing-history");
});

test("verification budget denies repeated expensive evidence instead of returning a prefix", async () => {
  const w = await mintWallet(), r = await mintRotation(w.id);
  denied(await run(bundle(Array(20).fill(r), [w.row], Array(1024).fill(null))), "resource-limit");
});
