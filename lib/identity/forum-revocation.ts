import { seaToPrincipalKey } from "./forum-check";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";

export type UnverifiedForumRevoke = Readonly<{
  v: 1; kind: "revoke"; principal: string; issuedAt: number;
  linkId: string; keySig: string; attest?: string;
}>;
function scalarText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || !value.length || value.length > max) return false;
  if (/get\s*\(|\['get'\]|\["get"\]|\\/.test(value)) return false;
  if (/[\u0000-\u001f\u007f-\u009f\ufeff\u200b-\u200f\u2028\u2029\ufffd]/.test(value)) return false;
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) return false;
  return value.trim() === value;
}

/** Snapshot own data properties without invoking getters or inherited fields. */
function snapshot(input: unknown): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (!("value" in descriptor)) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}


/** SociACL b7f9bc59 revoke wire contract. Parsing grants no authority. */
export function parseForumRevoke(input: unknown): Readonly<{ record: UnverifiedForumRevoke; bytes: Uint8Array }> | null {
  const r = snapshot(input);
  if (!r || r.v !== 1 || r.kind !== "revoke" || Object.keys(r).some(k =>
    !["v", "kind", "principal", "issuedAt", "linkId", "keySig", "attest"].includes(k))) return null;
  if (typeof r.principal !== "string" || !seaToPrincipalKey(r.principal) ||
    typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0 || Object.is(r.issuedAt, -0) ||
    typeof r.linkId !== "string" || !/^[0-9a-f]{64}$/.test(r.linkId) || !scalarText(r.keySig, 128)) return null;
  const hasAttest = Object.hasOwn(r, "attest");
  if (hasAttest && !scalarText(r.attest, 16384)) return null;
  const record: UnverifiedForumRevoke = Object.freeze({ v: 1, kind: "revoke", principal: r.principal,
    issuedAt: r.issuedAt, linkId: r.linkId, keySig: r.keySig, ...(hasAttest ? { attest: r.attest as string } : {}) });
  const fields = ["sociacl-revoke-v1", record.principal, record.linkId, String(record.issuedAt)].map(s => new TextEncoder().encode(s));
  const bytes = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  for (const field of fields) { view.setUint32(offset, field.length, true); offset += 4; bytes.set(field, offset); offset += field.length; }
  return Object.freeze({ record, bytes });
}

/** Present-time signature evidence ONLY. The caller must authenticate currentKey
 * for this principal at now. Never reuse this result as historical evidence or
 * trust its claimed issuance time after the signing key retires.
 */
export function verifyForumRevokeNow(input: unknown, currentKey: string, now: number): UnverifiedForumRevoke | null {
  if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0)) return null;
  const parsed = parseForumRevoke(input);
  if (!parsed || parsed.record.issuedAt > now || !verifyForumKeySignature(currentKey, parsed.record.keySig, parsed.bytes)) return null;
  return parsed.record;
}

/** Timestamped revocation evidence under a supplied signing key. Caller must
 * authenticate the key for the principal and selected evaluation time and bind
 * the target link. No offline fallback; expiry is evaluated at explicit `at`.
 */
export async function verifyForumRevokeWitness(input: unknown, signingKey: string, keys: readonly ForumWitnessKey[], at: number): Promise<UnverifiedForumRevoke | null> {
  const record = verifyForumRevokeNow(input, signingKey, at);
  if (!record || record.attest === undefined) return null;
  const c = verifyForumWitness(record.attest, keys, at);
  if (!c || Object.keys(c).some(k => !["typ", "principal", "recordId", "iat", "exp"].includes(k)) ||
    c.typ !== "sociacl-revoke-attest-v1" || c.principal !== record.principal || c.iat !== record.issuedAt) return null;
  try {
    const bytes = parseForumRevoke(record)!.bytes;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    const id = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    return c.recordId === id ? record : null;
  } catch { return null; }
}
