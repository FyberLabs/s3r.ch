import { releaseColor } from "./crash-report";

/** Infer the browser-facing HTTPS origin for session cookies and CORS checks. */
export function resolveSiteOrigin(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.S3RCH_SITE_ORIGIN?.trim();
  if (explicit) return explicit;
  const health = env.S3RCH_GUN_HEALTH_URL?.trim();
  if (health) {
    try {
      const peer = new URL(health);
      if (peer.protocol === "https:" && peer.pathname.startsWith("/_peer/") && peer.port === "") {
        return "https://" + peer.hostname;
      }
    } catch { /* ignore */ }
  }
  const color = env.S3RCH_RELEASE_COLOR === "staging" ? "production" : env.S3RCH_RELEASE_COLOR;
  if (color === "test") return "https://test.s3r.ch";
  if (releaseColor(color)) return "https://s3r.ch";
  return undefined;
}