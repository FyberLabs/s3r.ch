import { createHmac } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const experimentKeyVersionsCookie = "__Host-s3rch-experiment-key-versions";
const type = "s3rch-experiment-key-versions-v1";
const ttl = 365 * 24 * 60 * 60;
export type AssignmentKeyVersion = Readonly<{ key: string; hash: string; version: string }>;

/** An opaque identifier for a random server key; never a raw key or subject. */
export function experimentKeyVersion(secret: Uint8Array): string {
  return createHmac("sha256", secret).update("experiment.assignment-key-version.v1\0").digest("hex").slice(0, 16);
}

export async function readExperimentKeyVersions(token: string | null, anonymous: string,
  secrets: readonly Uint8Array[], now: number): Promise<readonly AssignmentKeyVersion[]> {
  if (!token || token.length > 3800) return [];
  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"], typ: type,
        issuer: "s3rch", audience: type, currentDate: new Date(now * 1000), requiredClaims: ["iat", "exp"] });
      if (payload.anonymous !== anonymous || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
          payload.iat! > now || payload.exp! - payload.iat! !== ttl || !Array.isArray(payload.versions) || payload.versions.length > 8) return [];
      const versions = payload.versions as AssignmentKeyVersion[];
      if (!versions.every(row => row && typeof row === "object" && Object.keys(row).sort().join() === "hash,key,version" &&
          typeof row.key === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(row.key) &&
          typeof row.hash === "string" && /^[a-f0-9]{64}$/.test(row.hash) &&
          typeof row.version === "string" && /^[a-f0-9]{16}$/.test(row.version)) ||
          new Set(versions.map(row => row.key)).size !== versions.length) return [];
      return versions;
    } catch { /* Try only configured signing keys; metadata never grants access. */ }
  }
  return [];
}

export async function signExperimentKeyVersions(versions: readonly AssignmentKeyVersion[], anonymous: string,
  secret: Uint8Array, now: number): Promise<string> {
  const token = await new SignJWT({ anonymous, versions }).setProtectedHeader({ alg: "HS256", typ: type })
    .setIssuer("s3rch").setAudience(type).setIssuedAt(now).setExpirationTime(now + ttl).sign(secret);
  if (token.length > 3800) throw Error("Experiment key metadata exceeds cookie limit");
  return `${experimentKeyVersionsCookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttl}`;
}
