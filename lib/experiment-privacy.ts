import { createHmac, randomUUID } from "node:crypto";
import { parseExperimentPayload, type ExperimentPayload } from "./experiment-contract";
import { SignJWT, jwtVerify, decodeJwt, type JWTPayload } from "jose";
export const experimentConsentCookie = "__Host-s3rch-experiment-consent";
export function experimentCookie(header: string, name: string): string | null {
  if (header.length > 16384) return null;
  const matches = header.split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
const attributes = "; Path=/; Secure; HttpOnly; SameSite=Lax";
export function clearExperimentCookies(): readonly string[] {
  return [experimentConsentCookie, "__Host-s3rch-experiment-id", "__Host-s3rch-experiments", "__Host-s3rch-experiment-key-versions"].map(name => `${name}=${attributes}; Max-Age=0`);
}
export function createExperimentPrivacy(input: { tenant: string; origin: string; secret: Uint8Array; previousSecrets?: readonly Uint8Array[]; clock?: () => number }) {
  const now = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const derive = (secret: Uint8Array) => createHmac("sha256", secret).update(`s3rch.experiment-session.v1\0${input.tenant}\0${input.origin}`).digest();
  const key = derive(input.secret), previous = (input.previousSecrets ?? []).map(derive);
  async function issue(type: string, claims: Record<string, unknown>, ttl: number) {
    const time = now();
    return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: type }).setIssuer(input.origin).setAudience(type).setIssuedAt(time).setExpirationTime(time + ttl).sign(key);
  }
  async function read(token: string | null, type: string, ttl: number, expiredForDeletion = false): Promise<(JWTPayload & { signingKey: Buffer }) | null> {
    if (!token || token.length > 4096) return null;
    for (const candidate of [key, ...previous]) {
    try {
      const validationTime = expiredForDeletion ? decodeJwt(token).iat : now();
      if (!Number.isSafeInteger(validationTime) || validationTime! > now() || validationTime! < 0) return null;
      const { payload } = await jwtVerify(token, candidate, { algorithms: ["HS256"], typ: type, issuer: input.origin, audience: type, currentDate: new Date(validationTime! * 1000), requiredClaims: ["iat", "exp"] });
      if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now() || payload.exp! - payload.iat! !== ttl) return null;
      return { ...payload, signingKey: candidate };
    } catch { /* Try only deployment-configured prior keys. */ }
    }
    return null;
  }
  return Object.freeze({
    async display(payload: ExperimentPayload, consent: string) {
      if (!parseExperimentPayload(payload) || !/^[a-f0-9]{64}$/.test(consent)) throw Error("Invalid display");
      return issue("s3rch-experiment-display-v1", { payload, consent }, 86400);
    },
    async displayed(token: string, consent: string) {
      const claims = await read(token, "s3rch-experiment-display-v1", 86400);
      return claims?.consent === consent ? parseExperimentPayload(claims.payload) : null;
    },
    async consent() {
      const id = randomUUID(); const token = await issue("s3rch-experiment-consent-v1", { id, tenant: input.tenant }, 86400);
      return `${experimentConsentCookie}=${token}${attributes}; Max-Age=86400`;
    },
    async privacy(cookies: string, expiredForDeletion = false) {
      const claims = await read(experimentCookie(cookies, experimentConsentCookie), "s3rch-experiment-consent-v1", 86400, expiredForDeletion);
      if (!claims || typeof claims.id !== "string" || !/^[0-9a-f-]{36}$/.test(claims.id)) return null;
      return { id: createHmac("sha256", claims.signingKey).update(claims.id).digest("hex"), retentionUntil: claims.exp! * 1000 };
    },
  });
}
