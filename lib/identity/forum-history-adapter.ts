import { isSeaPubkey } from "./forum-check";
import type { ForumKeyResolver } from "./forum-object-verification";

/** Already authenticated transitions, in chain order. The provider must verify
 * signatures, authorizer links, timestamp attestations, retained-link commitments,
 * and fork/conflict rules before returning this projection. Raw mesh is not one.
 */
export type AuthenticatedForumHistory = Readonly<{
  owner: string;
  evaluatedAt: number;
  rotations: readonly Readonly<{ seq: number; prevKey: string; nextKey: string; issuedAt: number }>[];
}>;
export type ForumHistoryProvider = (owner: string, now: number) => AuthenticatedForumHistory | null;

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/** Adapt trusted history to the object verifier. No cache and no genesis fallback
 * on provider failure. An authenticated empty history is distinct from no history.
 */
export function createForumKeyResolver(provider: ForumHistoryProvider | null): ForumKeyResolver {
  return (owner, issuedAt, now) => {
    if (!isSeaPubkey(owner) || !integer(issuedAt) || !integer(now) || typeof provider !== "function") return null;
    try {
      const supplied = provider(owner, now);
      if (!supplied || supplied.owner !== owner || supplied.evaluatedAt !== now || !Array.isArray(supplied.rotations) || supplied.rotations.length > 1024) return null;
      // Snapshot the trusted projection; never retain a provider-owned array.
      const rows = supplied.rotations.map(row => ({ seq: row.seq, prevKey: row.prevKey, nextKey: row.nextKey, issuedAt: row.issuedAt }));
      let currentKey = owner;
      let keyAtIssuedAt = owner;
      let lastTime = -1;
      const seen = new Set([owner]);
      for (const [index, row] of rows.entries()) {
        if (row.seq !== index + 1 || row.prevKey !== currentKey || !isSeaPubkey(row.nextKey) || seen.has(row.nextKey) ||
            !integer(row.issuedAt) || row.issuedAt <= lastTime || row.issuedAt > now) return null;
        currentKey = row.nextKey;
        if (row.issuedAt < issuedAt) keyAtIssuedAt = currentKey;
        lastTime = row.issuedAt;
        seen.add(currentKey);
      }
      // A record exactly at a rotation boundary belongs to the previous key.
      return Object.freeze({ owner, issuedAt, now, keyAtIssuedAt, currentKey });
    } catch {
      return null;
    }
  };
}
