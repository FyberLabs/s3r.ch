import { p256 } from "@noble/curves/nist.js";
import { FORUM_SEA_SELF_ROTATION_LINK } from "./forum-sociacl-rotation";
import { parseForumRotationCandidate } from "./forum-rotation-record";

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
const secret = (n: number) => { const bytes = new Uint8Array(32); bytes[31] = n; return bytes; };
const pub = (n: number) => {
  const bytes = p256.getPublicKey(secret(n), false);
  return b64(bytes.slice(1, 33)) + "." + b64(bytes.slice(33));
};
const sign = (bytes: Uint8Array, key: number) => p256.sign(bytes, secret(key), { prehash: true, format: "compact" });

/** Rotation attest signed by the rotating principal's previous SEA key (not deployment JWKS). */
export function signForumRotationAttest(
  prevKeyNumber: number, claims: Record<string, unknown>,
): string {
  const header = b64(JSON.stringify({ alg: "ES256", kid: "owner-rotate", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  const input = `${header}.${body}`;
  return `${input}.${b64(sign(new TextEncoder().encode(input), prevKeyNumber))}`;
}

/** Minimal self-authorized SEA rotation between local P-256 test keys. */
export function mintSeaForumRotation(options: {
  owner?: number;
  prev?: number;
  next?: number;
  principal?: string;
  prevKey?: string;
  nextKey?: string;
  at?: number;
  seq?: number;
} = {}) {
  const { owner = 1, prev = 1, next = 2, at = 120, seq = 1, principal: principalInput, prevKey: prevKeyInput, nextKey: nextKeyInput } = options;
  const principal = principalInput ?? pub(owner);
  const prevKey = prevKeyInput ?? pub(prev);
  const nextKey = nextKeyInput ?? pub(next);
  const row = {
    v: 1 as const,
    kind: "rotate" as const,
    principal,
    prevKey,
    nextKey,
    issuedAt: at,
    seq,
    retainedLinks: [] as string[],
    nextSig: "pending",
    attest: "pending",
    authorizer: {
      kind: "wallet" as const,
      link: FORUM_SEA_SELF_ROTATION_LINK,
      siwe: { message: "sociacl self rotation", signature: `0x${"00".repeat(65)}` },
    },
  };
  const candidate = parseForumRotationCandidate(row);
  if (!candidate) throw Error("bad rotation fixture");
  row.nextSig = b64(sign(candidate.bytes, next));
  row.attest = signForumRotationAttest(prev, {
    typ: "sociacl-rotate-attest-v2",
    principal: row.principal,
    nextKey: row.nextKey,
    seq: row.seq,
    iat: at,
    exp: at + 600,
    auth: "wallet",
    linkId: FORUM_SEA_SELF_ROTATION_LINK,
    retainedLinks: row.retainedLinks,
  });
  return row;
}

export const forumRotationTestPub = pub;