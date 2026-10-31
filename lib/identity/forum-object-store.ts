import { verifyForumObjectRecord, type ForumKeyResolver, type ForumObjectVerification } from "./forum-object-verification";
import type { UnverifiedObjectRecord } from "./forum-object-record";

type Failure = Extract<ForumObjectVerification, { ok: false }>;
export type ForumObjectAdmission = { ok: true; kept: boolean } | Failure | { ok: false; reason: "capacity" };
export const FORUM_OBJECT_CAP = 1024;

/** Signed ownership store, deliberately NOT the legacy writable SeeAcl.
 * The resolver is a trusted application dependency (see ForumKeyResolver).
 * Reads reverify at their explicit time; no cached boolean confers authority.
 * Records remain private, including during temporary history unavailability.
 */
export function createForumObjectStore(resolver: ForumKeyResolver | null) {
  const records = new Map<string, UnverifiedObjectRecord>();
  return Object.freeze({
    admit(input: unknown, now: number): ForumObjectAdmission {
      const verified = verifyForumObjectRecord(input, resolver, now);
      if (!verified.ok) return verified;
      const next = verified.record;
      const held = records.get(next.object);
      if (held) {
        // Keep the issuance floor even while the old signer cannot authorize.
        if (next.issuedAt <= held.issuedAt) return { ok: true, kept: false };
        if (verifyForumObjectRecord(held, resolver, now).ok) return { ok: true, kept: false };
      } else if (records.size >= FORUM_OBJECT_CAP) {
        return { ok: false, reason: "capacity" };
      }
      records.set(next.object, next);
      return { ok: true, kept: true };
    },
    ownerOf(object: string, now: number): string | undefined {
      const record = records.get(object);
      if (!record) return undefined;
      const verified = verifyForumObjectRecord(record, resolver, now);
      return verified.ok ? verified.record.owner : undefined;
    },
  });
}
