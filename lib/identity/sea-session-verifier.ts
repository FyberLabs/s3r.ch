import { jwtVerify } from "jose";
import { isSeaPubkey } from "./forum-check";
import { isPublicSquadPrincipal } from "../squad-view";

/** Verification only: shares the existing issuer's wire contract and holds no
 * challenge, exchange, replay-store or token-signing capability. */
export function createIdentityTokenVerifier(input: { origin: string; secret: string; clock?: () => number }) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:" || typeof input.secret !== "string" ||
      new TextEncoder().encode(input.secret).length < 32) throw Error("Explicit identity session configuration required");
  const secret = new TextEncoder().encode(input.secret), clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  async function claims(value: string, type: string, ttl: number) {
    if (typeof value !== "string" || value.length > 4096 ||
        !((type === "s3rch-identity-session-v1" && ttl === 300) || (/^s3rch-identity-challenge-v1(?::[0-9a-f]{64})?$/.test(type) && ttl === 60))) throw Error("Invalid session");
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw Error("Invalid session time");
    const { payload } = await jwtVerify(value, secret, { algorithms: ["HS256"], typ: type,
      issuer: origin.origin, audience: origin.origin, currentDate: new Date(now * 1000), requiredClaims: ["iat", "exp", "jti"] });
    if (typeof payload.sub !== "string" || !isSeaPubkey(payload.sub) || isPublicSquadPrincipal(payload.sub) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now ||
        payload.exp! - payload.iat! !== ttl || typeof payload.jti !== "string" || !/^[0-9a-f]{64}$/.test(payload.jti)) throw Error("Invalid session");
    return { key: payload.sub, id: payload.jti, expiresAt: payload.exp! };
  }
  return Object.freeze({ claims, async authenticate(value: string): Promise<{ key: string } | null> {
    try { return { key: (await claims(value, "s3rch-identity-session-v1", 300)).key }; } catch { return null; }
  } });
}
