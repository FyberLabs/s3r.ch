import { isSeaPubkey } from "./forum-check";
import { parseForumObjectRecord, type UnverifiedObjectRecord } from "./forum-object-record";
import { verifyForumKeySignature } from "./forum-key-signature";

/** Trusted adapter boundary, NOT wire data. The implementation must authenticate
 * complete key history, enforce fork/conflict rules, and resolve keys at these
 * exact times. A self-declared current key or an absent history is insufficient.
 * At a rotation timestamp, keyAtIssuedAt is the pre-rotation key (upstream rule).
 */
export type ForumKeyResolver = (owner: string, issuedAt: number, now: number) => {
  owner: string;
  issuedAt: number;
  now: number;
  keyAtIssuedAt: string;
  currentKey: string;
} | null;

export type ForumObjectVerification =
  | { ok: true; record: UnverifiedObjectRecord; key: string }
  | { ok: false; reason: "bad-record" | "future-record" | "missing-history" | "retired-key" | "bad-signature" };

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/** Verify at one explicit instant; never cache this allow across key changes.
 * Does not install ownership. The resolver is an application trust dependency,
 * not a callback accepted from a peer, record, or UI request.
 */
export function verifyForumObjectRecord(
  input: unknown,
  resolver: ForumKeyResolver | null,
  now: number,
  clockSkewSeconds = 0,
): ForumObjectVerification {
  const parsed = parseForumObjectRecord(input);
  if (!parsed || !integer(now) || !integer(clockSkewSeconds) || clockSkewSeconds > 300) return { ok: false, reason: "bad-record" };
  const { record, bytes } = parsed;
  // Difference avoids an unsafe now + skew near MAX_SAFE_INTEGER.
  if (record.issuedAt > now && record.issuedAt - now > clockSkewSeconds) return { ok: false, reason: "future-record" };
  if (typeof resolver !== "function") return { ok: false, reason: "missing-history" };
  let key: string;
  try {
    const state = resolver(record.owner, record.issuedAt, now);
    if (!state) return { ok: false, reason: "missing-history" };
    const { owner, issuedAt, now: resolvedAt, currentKey, keyAtIssuedAt } = state;
    if (owner !== record.owner || issuedAt !== record.issuedAt || resolvedAt !== now ||
        !isSeaPubkey(currentKey) || !isSeaPubkey(keyAtIssuedAt)) return { ok: false, reason: "missing-history" };
    if (keyAtIssuedAt !== currentKey) return { ok: false, reason: "retired-key" };
    key = currentKey;
  } catch {
    return { ok: false, reason: "missing-history" };
  }
  if (!verifyForumKeySignature(key, record.sig, bytes)) return { ok: false, reason: "bad-signature" };
  return Object.freeze({ ok: true, record, key });
}
