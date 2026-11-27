import { p256 } from "@noble/curves/nist.js";
import { isSeaPubkey } from "@/lib/identity/forum-check";
import vector from "@/lib/identity/vectors/forums.json";

function b64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
  let encoded = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
  while (encoded.endsWith("=")) encoded = encoded.slice(0, -1);
  return encoded;
}

function seaFromScalar(n: number): string {
  const point = p256.Point.BASE.multiply(BigInt(n)).toBytes(false);
  return `${b64url(point.slice(1, 33))}.${b64url(point.slice(33))}`;
}

/** Shared forum check-vector pubkeys (1·G, secondPubkey, 3·G … 12·G). */
export const PUBLIC_FORUM_VECTOR_PUBKEYS: readonly string[] = Object.freeze([
  vector.seaPubkey,
  vector.secondPubkey,
  ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(seaFromScalar),
]);

if (!PUBLIC_FORUM_VECTOR_PUBKEYS.every((pub) => isSeaPubkey(pub))) {
  throw new Error("bad public forum vector pubkeys");
}

const vectorKeySet = new Set(PUBLIC_FORUM_VECTOR_PUBKEYS);

/** Guards assignment replacement only; not session, ACL, or live coordination policy. */
export function isPublicForumVectorPubkey(principal: string): boolean {
  return vectorKeySet.has(principal);
}