import { p256 } from "@noble/curves/nist.js";
import { releaseColor } from "./crash-report";
import type { ForumAuthorityConfig } from "./identity/forum-authority";
import type { LiveSquadSpec } from "./squad-view";

export type SiteAclConfig = Readonly<{
  origin: string;
  authority: ForumAuthorityConfig;
}>;

const sortedKeys = (value: object) => Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join();
const exact = (x: unknown, keys: string): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x) && sortedKeys(x) === keys;

const strings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.length <= 32 && x.every(s => typeof s === "string" && s.length > 0 && s.length <= 2048) &&
  new Set(x).size === x.length;

export function parseForumAuthorityJson(raw: string): ForumAuthorityConfig {
  if (Buffer.byteLength(raw) > 24576) throw Error("invalid forum authority configuration");
  const c: unknown = JSON.parse(raw);
  if (!c || typeof c !== "object" || Array.isArray(c) || !exact(c, "keys,pinnedIssuers,policy")) {
    throw Error("invalid forum authority configuration");
  }
  const row = c as Record<string, unknown>;
  const policy = row.policy;
  if (!exact(policy, "allowedChainIds,allowedDomains,allowedUris") ||
      !strings(policy.allowedChainIds) || !strings(policy.allowedDomains) || !strings(policy.allowedUris) ||
      !strings(row.pinnedIssuers) || !Array.isArray(row.keys) || row.keys.length < 1 || row.keys.length > 16) {
    throw Error("invalid forum authority configuration");
  }
  const keys = new Set<string>(), material = new Set<string>();
  for (const k of row.keys as unknown[]) {
    if (!exact(k, "crv,kid,kty,notAfter,notBefore,x,y") || k.kty !== "EC" || k.crv !== "P-256" ||
        typeof k.kid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(k.kid) || keys.has(k.kid) ||
        typeof k.x !== "string" || typeof k.y !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(k.x) || !/^[A-Za-z0-9_-]{43}$/.test(k.y) ||
        !Number.isSafeInteger(k.notBefore) || !Number.isSafeInteger(k.notAfter) ||
        (k.notBefore as number) < 0 || (k.notAfter as number) <= (k.notBefore as number)) {
      throw Error("invalid forum witness policy");
    }
    const publicKey = k.x + "." + k.y;
    if (material.has(publicKey)) throw Error("witness must have independent key material");
    material.add(publicKey);
    keys.add(k.kid);
    p256.Point.fromBytes(Buffer.concat([Buffer.from([4]), Buffer.from(k.x, "base64url"), Buffer.from(k.y, "base64url")]));
  }
  return structuredClone(c as ForumAuthorityConfig);
}

/** Infer the browser-facing HTTPS origin from infrastructure wiring that predates site ACL. */
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

/** Witness policy alone enables site ACL; origin is optional and inferred when absent. */
export function parseSiteAclConfig(env: Record<string, string | undefined>): SiteAclConfig | null {
  const authorityRaw = env.S3RCH_FORUM_AUTHORITY?.trim();
  if (!authorityRaw) return null;
  const origin = resolveSiteOrigin(env);
  if (!origin) return null;
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:") throw Error("invalid site origin");
  return { origin, authority: parseForumAuthorityJson(authorityRaw) };
}

export type PublicSiteClientConfig = {
  origin: string;
  config: ForumAuthorityConfig;
  sessionBase: string;
  authorityEndpoint: string;
  statementEndpoint: string;
  squad?: LiveSquadSpec;
};

export function publicSiteClientConfig(c: SiteAclConfig): PublicSiteClientConfig {
  return structuredClone({
    origin: c.origin,
    config: c.authority,
    sessionBase: "/api/identity/sea",
    authorityEndpoint: "/api/site/authority",
    statementEndpoint: "/api/site/statement",
  });
}