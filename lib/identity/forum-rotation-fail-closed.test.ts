import test from "node:test";
import assert from "node:assert/strict";
import { createForumAuthority, FORUM_AUTHORITY_CONFIG } from "./forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./forum-authority-records";
import { parseForumRotationCandidate } from "./forum-rotation-record";
import { mintSeaForumRotation, forumRotationTestPub } from "./forum-rotation-test-helpers";
import { seaToPrincipalKey } from "./forum-check";
import { p256 } from "@noble/curves/nist.js";
import { resolveForumRecoveryHistory } from "./forum-recovery-history";
import type { ForumAuthoritySnapshot } from "./forum-authority";

const b64 = (x: Uint8Array | string) => Buffer.from(x).toString("base64url");
const secret = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const sign = (n: number, bytes: Uint8Array) => b64(p256.sign(bytes, secret(n), { prehash: true, format: "compact" }));
const signRow = (kind: AuthorityKind, row: Record<string, unknown>, key = 1) => {
  const record = { issuedAt: time - 10, ...row, sig: "pending" };
  const parsed = parseForumAuthority(kind, record); assert.ok(parsed);
  record.sig = b64(p256.sign(parsed.bytes, secret(key), { prehash: true, format: "compact" }));
  return { kind, soul: parsed.soul, record };
};
const owner = forumRotationTestPub(1), attacker = forumRotationTestPub(9), time = 1700000060;
const forum = `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`;

function forgedRotation() {
  const base = mintSeaForumRotation({ owner: 1, prev: 1, next: 9, principal: owner, prevKey: owner, nextKey: attacker, at: time - 30 });
  const parsed = parseForumRotationCandidate(base);
  assert.ok(parsed);
  return { ...base, nextSig: sign(9, parsed.bytes), attest: "forged.attest.token" };
}

test("forged owner-chain rotation is unavailable without SociACL witness keys", async () => {
  const rotation = forgedRotation();
  const history = { completeThrough: time, links: [], accounts: [{ principal: owner, rotations: [rotation], revocations: [], genesisEpubBindings: [] }] };
  const result = await resolveForumRecoveryHistory(owner, history, [], { allowedDomains: [], allowedUris: [], allowedChainIds: [], clockSkewSeconds: 0 }, time);
  assert.equal(result.ok, false);
});

test("authority snapshots with unwitnessed rotations fail closed", async () => {
  const objectRow = signRow("object", { object: forum, owner }, 1);
  const rotation = mintSeaForumRotation({ at: time - 30 });
  const snapshot: ForumAuthoritySnapshot = { completeThrough: time, rows: [objectRow],
    history: { completeThrough: time, links: [], accounts: [{ principal: owner, rotations: [rotation], revocations: [], genesisEpubBindings: [] }] } };
  const authority = createForumAuthority(FORUM_AUTHORITY_CONFIG, () => time);
  assert.equal((await authority.refresh(snapshot, time)).ok, false);
});

test("forged owner attest and key9 takeover rotations stay unavailable without SociACL", async () => {
  const takeover = forgedRotation();
  const result = await resolveForumRecoveryHistory(attacker, { completeThrough: time, links: [],
    accounts: [{ principal: owner, rotations: [takeover], revocations: [], genesisEpubBindings: [] }] },
    [], { allowedDomains: [], allowedUris: [], allowedChainIds: [], clockSkewSeconds: 0 }, time);
  assert.equal(result.ok, false);
});