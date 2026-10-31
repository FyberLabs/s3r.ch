/** Consumer copy of SociACL's object-record wire boundary (b7f9bc59).
 * Parsing is NOT signature verification or authority admission. Never feed this
 * result into legacy putObject without current-key verification.
 */
import { seaToPrincipalKey } from "./forum-check";

export type UnverifiedObjectRecord = Readonly<{
  object: string;
  owner: string;
  issuedAt: number;
  sig: string;
}>;

const DOMAIN = "sociacl-object-v2";
const RESERVED = new Set(["claim", "ext", "post", "member", "objset"]);

function signatureText(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length > 128) return false;
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

/** Validates and snapshots the record and produces little-endian length-prefixed
 * UTF-8 signing bytes. The caller must still verify the signature and key history.
 */
export function parseForumObjectRecord(input: unknown): Readonly<{
  record: UnverifiedObjectRecord;
  bytes: Uint8Array;
}> | null {
  const row = snapshot(input);
  if (!row || (row.domain !== undefined && row.domain !== DOMAIN)) return null;
  if (typeof row.object !== "string" || typeof row.owner !== "string") return null;
  const parts = /^([a-z][a-z0-9]{1,15})_(p_[0-9a-f]{128})_([0-9a-f]{32})$/.exec(row.object);
  if (!parts || RESERVED.has(parts[1])) return null;
  const principal = seaToPrincipalKey(row.owner);
  if (!principal || parts[2] !== principal) return null;
  if (typeof row.issuedAt !== "number" || !Number.isSafeInteger(row.issuedAt) || row.issuedAt < 0 || Object.is(row.issuedAt, -0)) return null;
  if (!signatureText(row.sig)) return null;
  const record = Object.freeze({ object: row.object, owner: row.owner, issuedAt: row.issuedAt, sig: row.sig });
  const encoder = new TextEncoder();
  const fields = [DOMAIN, record.object, record.owner, String(record.issuedAt)].map(value => encoder.encode(value));
  const bytes = new Uint8Array(fields.reduce((size, field) => size + 4 + field.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length, true);
    offset += 4;
    bytes.set(field, offset);
    offset += field.length;
  }
  return Object.freeze({ record, bytes });
}
