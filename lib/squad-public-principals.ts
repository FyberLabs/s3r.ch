import { p256 } from "@noble/curves/nist.js";
import { isSeaPubkey } from "@/lib/identity/check";
import vector from "@/lib/identity/vectors/forums.json";

export const PUBLIC_SQUAD_FORUM_ID = vector.forumId;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function seaFrom(n: number): string {
  const point = p256.Point.BASE.multiply(BigInt(n)).toBytes(false);
  return `${b64url(point.slice(1, 33))}.${b64url(point.slice(33))}`;
}

const fixturePrincipals = [
  vector.seaPubkey,
  vector.secondPubkey,
  seaFrom(3),
  seaFrom(4),
  seaFrom(5),
  seaFrom(6),
  seaFrom(7),
  seaFrom(8),
  seaFrom(9),
  seaFrom(10),
  seaFrom(11),
  seaFrom(12),
];

if (!fixturePrincipals.every((pub) => isSeaPubkey(pub))) {
  throw new Error("bad public squad vector principals");
}

/** Forum check vectors shared in repo docs; refuse as live owners or session subjects. */
export const publicSquadPrincipals: ReadonlySet<string> = new Set(fixturePrincipals);