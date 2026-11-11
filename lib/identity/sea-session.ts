import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { readForumSignature } from "../forum-sign";
import { isPublicSquadPrincipal } from "../squad-view";
import { isSeaPubkey } from "./forum-check";

/** Server-side proof-of-possession sessions. consume must atomically record a
 * previously unused challenge ID until expiresAt, across all service instances.
 * Failure or unavailable storage must return false or throw, never grant reuse.
 * This proves key possession only; current principal/ACL checks remain mandatory.
 */
export function createIdentitySessions(input: {
  origin: string; secret: string;
  consume(id: string, expiresAt: number): Promise<boolean>;
  clock?: () => number;
}) {
  if (typeof input.secret !== "string" || new TextEncoder().encode(input.secret).length < 32) throw Error("Explicit identity session configuration required");
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  const secret = new TextEncoder().encode(input.secret), issuer = origin.origin, audience = issuer;
  const consume = input.consume, clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const challengeType = "s3rch-identity-challenge-v1", sessionType = "s3rch-identity-session-v1";
  async function token(type: string, key: string, ttl: number, id?: string) {
    const now = clock();
    return new SignJWT({}).setSubject(key).setProtectedHeader({ alg: "HS256", typ: type })
      .setIssuer(issuer).setAudience(audience).setIssuedAt(now).setExpirationTime(now + ttl)
      .setJti(id ?? randomBytes(32).toString("hex")).sign(secret);
  }
  async function claims(value: string, type: string, ttl: number) {
    if (typeof value !== "string" || value.length > 4096) throw Error("Invalid session");
    const now = clock();
    const { payload } = await jwtVerify(value, secret, { algorithms: ["HS256"], typ: type,
      issuer, audience, currentDate: new Date(now * 1000), requiredClaims: ["iat", "exp", "jti"] });
    if (typeof payload.sub !== "string" || !isSeaPubkey(payload.sub) || isPublicSquadPrincipal(payload.sub) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now ||
        payload.exp! - payload.iat! !== ttl || typeof payload.jti !== "string" || !/^[0-9a-f]{64}$/.test(payload.jti)) throw Error("Invalid session");
    return { key: payload.sub, id: payload.jti, expiresAt: payload.exp! };
  }
  return Object.freeze({
    async challenge(key: string) {
      if (!isSeaPubkey(key) || isPublicSquadPrincipal(key)) throw Error("Private SEA key required");
      // Sign this exact opaque string with signForumRecord(token, pair).
      return token(challengeType, key, 60);
    },
    async exchange(challenge: string, signature: string): Promise<string | null> {
      try {
        const proof = await claims(challenge, challengeType, 60);
        if (typeof signature !== "string" || signature.length > 16384 || await readForumSignature(signature, proof.key) !== challenge) return null;
        // Verification and storage can cross expiration; recheck both sides of consume.
        await claims(challenge, challengeType, 60);
        if (!await consume(proof.id, proof.expiresAt)) return null;
        await claims(challenge, challengeType, 60);
        return token(sessionType, proof.key, 300);
      } catch { return null; }
    },
    async authenticate(value: string): Promise<{ key: string } | null> {
      try { return { key: (await claims(value, sessionType, 300)).key }; } catch { return null; }
    },
  });
}
