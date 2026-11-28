import { LOCAL_SESSION_SECRET, MIN_SECRET_LENGTH } from "./config";

export class IdentitySecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentitySecretError";
  }
}

type EnvLike = {
  S3RCH_SESSION_SIGNING_KEY?: string;
  NODE_ENV?: string;
};

/**
 * HMAC key for nonce and session cookies until asymmetric session tokens land.
 * Production: missing or short secret is a hard failure (routes return 500).
 * Non-production: unset secret uses LOCAL_SESSION_SECRET. A present-but-short
 * secret is always rejected.
 */
export function getIdentitySecret(env: EnvLike = process.env): string {
  const secret = env.S3RCH_SESSION_SIGNING_KEY;
  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    return secret;
  }
  if (secret) {
    throw new IdentitySecretError(
      "S3RCH_SESSION_SIGNING_KEY must be at least 32 characters.",
    );
  }
  if (env.NODE_ENV === "production") {
    throw new IdentitySecretError(
      "S3RCH_SESSION_SIGNING_KEY is required in production (min 32 characters).",
    );
  }
  return LOCAL_SESSION_SECRET;
}

export function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
