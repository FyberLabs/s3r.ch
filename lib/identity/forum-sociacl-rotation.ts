import { verifyRotate, verifyKeySignature, type ResolutionContext } from "sociacl-ids";
import { parseForumRotationCandidate, type UnverifiedForumRotation } from "./forum-rotation-record";
import type { ForumSiwePolicy } from "./forum-siwe";
import type { ForumWitnessKey } from "./forum-witness-verification";

/** Self-authorized SEA rotation when no recovery authorizer link row is present. */
export const FORUM_SEA_SELF_ROTATION_LINK = "0".repeat(64);

const FAIL_CLOSED_POLICY: ForumSiwePolicy = Object.freeze({
  allowedDomains: Object.freeze([]),
  allowedUris: Object.freeze([]),
  allowedChainIds: Object.freeze([]),
  clockSkewSeconds: 0,
});

export type ForumRotationTransitionEvidence = Readonly<{
  record: UnverifiedForumRotation;
  recoveryProof: "unverified" | "malformed";
  witnessClaims: Readonly<Record<string, unknown>>;
}>;

function ownerWitnessKey(pub: string, kid = "owner-rotate"): ForumWitnessKey | null {
  const parts = pub.split(".");
  if (parts.length !== 2) return null;
  return Object.freeze({
    kid, kty: "EC", crv: "P-256", x: parts[0], y: parts[1], notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER,
  });
}

function parseAttestClaims(token: string, signerKey: string): Readonly<Record<string, unknown>> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    if (!verifyKeySignature(signerKey, parts[2], new TextEncoder().encode(parts[0] + "." + parts[1]))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return Object.freeze(claims as Record<string, unknown>);
  } catch {
    return null;
  }
}

function verifySelfRotationTransition(
  r: UnverifiedForumRotation, bytes: Uint8Array, recoveryProof: "unverified" | "malformed", now: number,
): ForumRotationTransitionEvidence | null {
  if (r.authorizer.link !== FORUM_SEA_SELF_ROTATION_LINK || r.retainedLinks.length !== 0 || r.issuedAt > now) return null;
  if (!verifyKeySignature(r.nextKey, r.nextSig, bytes)) return null;
  const claims = parseAttestClaims(r.attest, r.prevKey);
  if (!claims || claims.typ !== "sociacl-rotate-attest-v2" || claims.principal !== r.principal || claims.nextKey !== r.nextKey ||
    claims.seq !== r.seq || claims.iat !== r.issuedAt) return null;
  return Object.freeze({ record: r, recoveryProof, witnessClaims: claims });
}

/** SociACL rotation transition check with owner-chain JWKS (prevKey), not deployment witnesses. */
export function verifyForumRotationTransition(
  input: unknown, now: number, links: ReadonlyMap<string, unknown> = new Map(),
  pinnedIss: readonly string[] = [],
): ForumRotationTransitionEvidence | null {
  if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0)) return null;
  const candidate = parseForumRotationCandidate(input);
  if (!candidate || candidate.record.issuedAt > now) return null;
  const { record: r, bytes, recoveryProof } = candidate;
  if (r.authorizer.link === FORUM_SEA_SELF_ROTATION_LINK && r.retainedLinks.length === 0) {
    return verifySelfRotationTransition(r, bytes, recoveryProof, now);
  }
  const ownerKey = ownerWitnessKey(r.prevKey);
  if (!ownerKey) return null;
  const ctx: ResolutionContext = {
    now,
    jwks: { keys: [ownerKey] },
    policy: FAIL_CLOSED_POLICY,
    pinnedIss: new Set(pinnedIss),
    links,
    revocations: [],
    history: () => ({ ok: false, reason: "missing-history" }),
  };
  const verified = verifyRotate(r, r.prevKey, ctx);
  if (!verified.ok) return null;
  const claims = parseAttestClaims(r.attest, r.prevKey);
  if (!claims) return null;
  return Object.freeze({ record: r, recoveryProof, witnessClaims: claims });
}

/** sociacl-acl-attest-v1 signed by the owner's current SEA key (verifyKeySignature). */
export function verifyForumAclAttestByOwner(
  token: unknown, ownerKey: string, issuedAt: number, at: number, skew = 0,
): Readonly<Record<string, unknown>> | null {
  const claims = typeof token === "string" ? parseAttestClaims(token, ownerKey) : null;
  if (!claims) return null;
  const { iat, exp } = claims;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || iat !== issuedAt) return null;
  if (iat > at && iat - at > skew) return null;
  if (exp <= at && at - exp > skew) return null;
  return claims;
}