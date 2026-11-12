import type { ForumAuthorityGraph, ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import type { AssignmentSigningIntent } from "./assignment-signing-plan";

type Row = ForumAuthoritySnapshot["rows"][number];
export type AssignmentSignedMaterial = Readonly<{ issuedAt: number; cancellations: readonly Row[]; grants: readonly Row[] }>;
/** Structural bound for durable material. Signature admission belongs to
 * verifyAssignmentSignedMaterial before the journal claim. */
export function parseAssignmentSignedMaterial(value: unknown): AssignmentSignedMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "cancellations,grants,issuedAt") throw Error("Invalid signed assignment material");
  const material = value as AssignmentSignedMaterial;
  if (!Number.isSafeInteger(material.issuedAt) || material.issuedAt < 0 ||
      !Array.isArray(material.cancellations) || !Array.isArray(material.grants) ||
      material.cancellations.length < 2 || material.cancellations.length > 192 || material.grants.length < 2 || material.grants.length > 128)
    throw Error("Invalid signed assignment bounds");
  const rows = (values: readonly Row[]) => Object.freeze(values.map(row => {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "kind,record,soul") throw Error("Invalid signed assignment row");
    const parsed = parseForumAuthority(row.kind, row.record);
    if (!parsed || parsed.soul !== row.soul || parsed.row.issuedAt !== material.issuedAt || "attest" in parsed.row ||
        !["post", "see", "cancel"].includes(parsed.kind)) throw Error("Invalid signed assignment record");
    return Object.freeze({ kind: parsed.kind, soul: parsed.soul, record: parsed.row });
  }));
  return Object.freeze({ issuedAt: material.issuedAt, cancellations: rows(material.cancellations), grants: rows(material.grants) });
}
/** The expected intents must be recomputed from current admitted authority and
 * the claimed journal revision. No private key or signing callback is used. */
export function verifyAssignmentSignedMaterial(value: unknown, expected: {
  issuedAt: number; cancellations: readonly AssignmentSigningIntent[]; grants: readonly AssignmentSigningIntent[];
}, graph: Pick<ForumAuthorityGraph, "writerKey">, at: number): AssignmentSignedMaterial {
  const material = parseAssignmentSignedMaterial(value);
  if (!Number.isSafeInteger(at) || material.issuedAt !== expected.issuedAt || material.issuedAt > at || at - material.issuedAt > 300)
    throw Error("Signed assignment expired");
  for (const phase of ["cancellations", "grants"] as const) {
    if (material[phase].length !== expected[phase].length) throw Error("Signed assignment changed");
    for (let i = 0; i < material[phase].length; i++) {
      const row = material[phase][i], intent = expected[phase][i];
      const parsed = parseForumAuthority(row.kind, row.record)!;
      const planned = parseForumAuthority(intent.kind, { ...intent.fields, sig: "pending" });
      if (!planned || row.kind !== intent.kind || row.soul !== intent.soul || parsed.bytes.length !== planned.bytes.length ||
          parsed.bytes.some((byte, index) => byte !== planned.bytes[index])) throw Error("Signed assignment changed");
      const key = graph.writerKey(parsed.signer, parsed.row.issuedAt, at);
      if (!key || !verifyForumKeySignature(key, parsed.row.sig, parsed.bytes)) throw Error("Invalid assignment signature");
    }
  }
  return material;
}
