import { seaToPrincipalKey } from "./forum-check";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";

// Consumer contracts copied/retyped from SociACL b7f9bc59 records.js/ids.js.
export const recoveryInteger = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
export function recoveryObject(input: unknown): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (!("value" in d)) return null;
      out[k] = d.value;
    }
    return out;
  } catch { return null; }
}
export function recoveryList(input: unknown): unknown[] | null {
  try {
    if (!Array.isArray(input)) return null;
    const d = Object.getOwnPropertyDescriptors(input) as unknown as Record<string, PropertyDescriptor>;
    const length: unknown = d.length.value;
    if (!recoveryInteger(length) || length > 1024) return null;
    return Array.from({ length }, (_, i) => d[String(i)]?.value);
  } catch { return null; }
}
function scalar(x: unknown, max: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= max && x.trim() === x &&
    !/get\s*\(|\['get'\]|\["get"\]|\\|[\u0000-\u001f\u007f-\u009f\ufeff\u200b-\u200f\u2028\u2029\ufffd]/.test(x) &&
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(x);
}
export function recoveryBytes(fields: readonly string[]): Uint8Array {
  const parts = fields.map(s => new TextEncoder().encode(s));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  for (const p of parts) { view.setUint32(offset, p.length, true); offset += 4; bytes.set(p, offset); offset += p.length; }
  return bytes;
}
export async function recoveryId(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), b => b.toString(16).padStart(2, "0")).join("");
}
export type ForumOidcLink = Readonly<{
  v: 1; kind: "oidc"; principal: string; issuedAt: number; nonce: string; keySig: string; attest: string;
  cred: Readonly<{ iss: string; tenant: string; sub: string }>;
}>;
export type ForumGenesisEpub = Readonly<{
  v: 1; kind: "genesis-epub"; principal: string; issuedAt: number; epub: string; keySig: string; attest: string;
}>;
export function parseForumRecoveryRecord(input: unknown): Readonly<{ record: ForumOidcLink | ForumGenesisEpub; bytes: Uint8Array }> | null {
  const r = recoveryObject(input);
  if (!r || r.v !== 1 || typeof r.principal !== "string" || !seaToPrincipalKey(r.principal) || !recoveryInteger(r.issuedAt) ||
    !scalar(r.keySig, 128) || !scalar(r.attest, 16384)) return null;
  const common = ["v", "kind", "principal", "issuedAt", "keySig", "attest"];
  if (r.kind === "genesis-epub") {
    if (Object.keys(r).some(k => ![...common, "epub"].includes(k)) || typeof r.epub !== "string" || !seaToPrincipalKey(r.epub) || r.epub === r.principal) return null;
    const record: ForumGenesisEpub = Object.freeze({ v: 1, kind: r.kind, principal: r.principal, issuedAt: r.issuedAt, epub: r.epub, keySig: r.keySig, attest: r.attest });
    return { record, bytes: recoveryBytes(["sociacl-genesis-epub-v1", record.principal, record.epub, String(record.issuedAt)]) };
  }
  if (r.kind !== "oidc" || Object.keys(r).some(k => ![...common, "cred", "nonce"].includes(k)) || typeof r.nonce !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(r.nonce)) return null;
  const c = recoveryObject(r.cred);
  if (!c || Object.keys(c).some(k => !["iss", "tenant", "sub"].includes(k)) || !scalar(c.iss, 2048) || !/^https:\/\/[\x21-\x7e]{1,2040}$/.test(c.iss) ||
    typeof c.tenant !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.tenant) || !scalar(c.sub, 255) || !/^[\x21-\x7e]+$/.test(c.sub)) return null;
  const record: ForumOidcLink = Object.freeze({ v: 1, kind: r.kind, principal: r.principal, issuedAt: r.issuedAt, nonce: r.nonce, keySig: r.keySig, attest: r.attest,
    cred: Object.freeze({ iss: c.iss, tenant: c.tenant, sub: c.sub }) });
  return { record, bytes: recoveryBytes(["sociacl-link-oidc-v1", record.principal, record.cred.iss, record.cred.tenant, record.cred.sub, String(record.issuedAt), record.nonce]) };
}
export function verifyForumRecoveryWitness(record: ForumOidcLink | ForumGenesisEpub, keys: readonly ForumWitnessKey[], pinnedIssuers: readonly string[]): boolean {
  const c = verifyForumWitness(record.attest, keys, record.issuedAt);
  if (!c || c.principal !== record.principal || c.iat !== record.issuedAt) return false;
  if (record.kind === "genesis-epub") {
    const parsed = parseForumRecoveryRecord(record)!;
    return Object.keys(c).every(k => ["typ", "principal", "epub", "iat", "exp"].includes(k)) && c.typ === "sociacl-genesis-epub-attest-v1" && c.epub === record.epub &&
      verifyForumKeySignature(record.principal, record.keySig, parsed.bytes);
  }
  return pinnedIssuers.includes(record.cred.iss) && Object.keys(c).every(k => ["typ", "iss", "tenant", "sub", "principal", "iat", "exp", "nonce"].includes(k)) &&
    c.typ === "sociacl-oidc-attest-v1" && c.iss === record.cred.iss && c.tenant === record.cred.tenant && c.sub === record.cred.sub && c.nonce === record.nonce;
}
