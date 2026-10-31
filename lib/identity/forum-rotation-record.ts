/** Consumer copy of SociACL rotation wire/signing contracts (b7f9bc59).
 * This is parsing, not authenticated history. A next-key signature alone cannot
 * authorize recovery: link eligibility, SIWE/OIDC, timestamp witnesses, retained
 * links and fork/conflict detection must also pass in the history provider.
 */
import { seaToPrincipalKey } from "./forum-check";

export type UnverifiedForumRotation = Readonly<{
  v: 1;
  kind: "rotate";
  principal: string;
  issuedAt: number;
  seq: number;
  prevKey: string;
  nextKey: string;
  nextEpub?: string;
  nextSig: string;
  attest: string;
  retainedLinks: readonly string[];
  authorizer: Readonly<{ kind: "oidc-fresh-login"; link: string }> |
    Readonly<{ kind: "wallet"; link: string; siwe: Readonly<{ message: string; signature: string }> }>;
}>;

function data(input: unknown): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (!("value" in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}
const only = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).every(key => keys.includes(key));
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
const key = (s: unknown): s is string => typeof s === "string" && seaToPrincipalKey(s) !== null;
const link = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
function text(s: unknown, max: number): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= max && s.trim() === s &&
    !/get\s*\(|\['get'\]|\["get"\]|\\/.test(s) &&
    !/[\u0000-\u001f\u007f-\u009f\ufeff\u200b-\u200f\u2028\u2029\ufffd]/.test(s) &&
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}
function retained(input: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(input)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<string, PropertyDescriptor>;
    const length: unknown = descriptors.length.value;
    if (!integer(length) || length > 1024) return null;
    const values: string[] = [];
    for (let i = 0; i < length; i++) {
      const value: unknown = descriptors[String(i)]?.value;
      if (!link(value) || (i > 0 && values[i - 1] >= value)) return null;
      values.push(value);
    }
    return Object.freeze(values);
  } catch { return null; }
}

/** Strict transport parser. A null result is NOT permission for a history
 * resolver to discard a possible fork: SociACL's rotationCandidate handling
 * must separately preserve signed identities with missing/malformed SIWE proofs.
 */
export function parseForumRotationRecord(input: unknown): Readonly<{
  record: UnverifiedForumRotation;
  bytes: Uint8Array;
}> | null {
  const r = data(input);
  if (!r || r.v !== 1 || r.kind !== "rotate" || !only(r, ["v", "kind", "principal", "issuedAt", "seq", "prevKey", "nextKey", "nextEpub", "nextSig", "attest", "retainedLinks", "authorizer"])) return null;
  if (!key(r.principal) || !key(r.prevKey) || !key(r.nextKey) || !integer(r.issuedAt) || !integer(r.seq) || r.seq === 0) return null;
  const hasEpub = Object.hasOwn(r, "nextEpub");
  if (hasEpub && !key(r.nextEpub)) return null;
  if (!text(r.nextSig, 128) || !text(r.attest, 16384)) return null;
  const retainedLinks = retained(r.retainedLinks);
  const a = data(r.authorizer);
  if (!retainedLinks || !a || !link(a.link)) return null;
  let authorizer: UnverifiedForumRotation["authorizer"];
  if (a.kind === "oidc-fresh-login" && only(a, ["kind", "link"])) {
    authorizer = Object.freeze({ kind: a.kind, link: a.link });
  } else if (a.kind === "wallet" && only(a, ["kind", "link", "siwe"])) {
    const s = data(a.siwe);
    if (!s || !only(s, ["message", "signature"]) || typeof s.message !== "string" || s.message.length > 8192 || typeof s.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s.signature)) return null;
    authorizer = Object.freeze({ kind: a.kind, link: a.link, siwe: Object.freeze({ message: s.message, signature: s.signature }) });
  } else return null;
  const record: UnverifiedForumRotation = Object.freeze({
    v: 1, kind: "rotate", principal: r.principal, issuedAt: r.issuedAt,
    seq: r.seq, prevKey: r.prevKey, nextKey: r.nextKey,
    ...(hasEpub ? { nextEpub: r.nextEpub as string } : {}),
    nextSig: r.nextSig, attest: r.attest, retainedLinks, authorizer,
  });
  const fields = [hasEpub ? "sociacl-rotate-v3" : "sociacl-rotate-v2", record.principal,
    String(record.seq), record.prevKey, record.nextKey, ...(hasEpub ? [record.nextEpub!] : []),
    String(record.issuedAt), authorizer.kind, authorizer.link, String(retainedLinks.length), ...retainedLinks]
    .map(value => new TextEncoder().encode(value));
  const bytes = new Uint8Array(fields.reduce((n, field) => n + 4 + field.length, 0));
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
