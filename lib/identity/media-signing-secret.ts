import { LOCAL_SESSION_SECRET, MIN_SECRET_LENGTH } from "./config";

export function getMediaSigningSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.S3RCH_MEDIA_SIGNING_KEY?.trim();
  if (secret && secret.length >= MIN_SECRET_LENGTH) return secret;
  if (secret) throw Error("S3RCH_MEDIA_SIGNING_KEY must be at least 32 characters.");
  if (env.NODE_ENV === "production") throw Error("S3RCH_MEDIA_SIGNING_KEY is required in production.");
  return LOCAL_SESSION_SECRET;
}