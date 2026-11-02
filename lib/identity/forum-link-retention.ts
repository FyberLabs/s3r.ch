import { createForumKeyResolver, type AuthenticatedForumHistory } from "./forum-history-adapter";

/** Trusted authenticated history, including each signed retention commitment.
 * Providers must verify recovery evidence and reject forks/conflicts before
 * returning this projection. This adapter cannot authenticate raw mesh history.
 */
export type AuthenticatedForumLinkHistory = Omit<AuthenticatedForumHistory, "rotations"> & Readonly<{
  rotations: readonly (AuthenticatedForumHistory["rotations"][number] & Readonly<{ retainedLinks: readonly string[] }>)[];
}>;
export type ForumLinkHistoryProvider = (owner: string, now: number) => AuthenticatedForumLinkHistory | null;

/** Derive issuance/current keys and intersection of all applicable commitments.
 * null retention means no rotation at/after issuance; [] means none survived.
 * A later rotation cannot restore a link dropped by an earlier rotation.
 * Mirrors SociACL b7f9bc59 historyState, using the existing chain validator.
 */
export function createForumLinkKeyResolver(provider: ForumLinkHistoryProvider | null) {
  return (owner: string, issuedAt: number, now: number): Readonly<{
    owner: string; issuedAt: number; now: number; keyAtIssuedAt: string; currentKey: string;
    retainedLinks: readonly string[] | null;
  }> | null => {
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || Object.is(issuedAt, -0) ||
      !Number.isSafeInteger(now) || now < 0 || Object.is(now, -0) || issuedAt > now || typeof provider !== "function") return null;
    try {
      const supplied = provider(owner, now);
      if (!supplied || !Array.isArray(supplied.rotations) || supplied.rotations.length > 1024) return null;
      const rows = supplied.rotations.map(r => {
        if (!Array.isArray(r.retainedLinks) || r.retainedLinks.length > 1024) throw Error("bad-retention");
        const retainedLinks = [...r.retainedLinks];
        if (!retainedLinks.every((id, i) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id) && (i === 0 || retainedLinks[i - 1] < id))) throw Error("bad-retention");
        return { seq: r.seq, prevKey: r.prevKey, nextKey: r.nextKey, issuedAt: r.issuedAt, retainedLinks };
      });
      const snapshot = { owner: supplied.owner, evaluatedAt: supplied.evaluatedAt, rotations: rows };
      const state = createForumKeyResolver(() => snapshot)(owner, issuedAt, now);
      if (!state) return null;
      let retained: string[] | null = null;
      for (const row of rows) {
        // Exact rotation boundaries use the pre-rotation key and must survive
        // that rotation's retention commitment too.
        if (row.issuedAt < issuedAt) continue;
        if (retained === null) retained = row.retainedLinks;
        else {
          const ids = new Set(row.retainedLinks);
          retained = retained.filter(id => ids.has(id));
        }
      }
      return Object.freeze({ ...state, retainedLinks: retained === null ? null : Object.freeze(retained) });
    } catch { return null; }
  };
}
