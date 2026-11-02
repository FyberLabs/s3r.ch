import { getAddress } from "viem";
import { seaToPrincipalKey } from "./forum-check";

export type UnverifiedForumWalletLink = Readonly<{
  v: 1; kind: "wallet"; principal: string; address: string;
  issuedAt: number; nonce: string; keySig: string; attest: string;
  siwe: Readonly<{ message: string; signature: string }>;
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

/** Consumer copy of SociACL b7f9bc59 wallet-link wire/signing contract.
 * Parsing establishes no authority. Both signatures, timestamp witness, key
 * history, retention and revocation checks remain required for recovery use.
 */
export function parseForumWalletLinkRecord(input: unknown): Readonly<{
  record: UnverifiedForumWalletLink; bytes: Uint8Array;
}> | null {
  const r = snapshot(input);
  if (!r || r.v !== 1 || r.kind !== "wallet" || Object.keys(r).some(k =>
    !["v", "kind", "principal", "address", "issuedAt", "nonce", "keySig", "attest", "siwe"].includes(k))) return null;
  if (typeof r.principal !== "string" || !seaToPrincipalKey(r.principal) ||
    typeof r.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) return null;
  try { if (getAddress(r.address) !== r.address) return null; } catch { return null; }
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0 || Object.is(r.issuedAt, -0)) return null;
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(r.nonce) || !scalarText(r.keySig, 128) || !scalarText(r.attest, 16384)) return null;
  const s = snapshot(r.siwe);
  if (!s || Object.keys(s).some(k => !["message", "signature"].includes(k)) ||
    typeof s.message !== "string" || s.message.length > 8192 || typeof s.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s.signature)) return null;
  const record: UnverifiedForumWalletLink = Object.freeze({ v: 1, kind: "wallet", principal: r.principal,
    address: r.address, issuedAt: r.issuedAt, nonce: r.nonce, keySig: r.keySig, attest: r.attest,
    siwe: Object.freeze({ message: s.message, signature: s.signature }) });
  const fields = ["sociacl-link-wallet-v1", record.principal, record.address, String(record.issuedAt), record.nonce]
    .map(s => new TextEncoder().encode(s));
  const bytes = new Uint8Array(fields.reduce((size, field) => size + 4 + field.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length, true); offset += 4;
    bytes.set(field, offset); offset += field.length;
  }
  return Object.freeze({ record, bytes });
}
