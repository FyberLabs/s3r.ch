/**
 * Login providers. SIWE is the wallet sign-in and is always available, since
 * the wallet address owns s3r.ch data. OIDC providers are backup sign-ins
 * that bind to that wallet (see link.ts).
 *
 * Configuration, server-only:
 *
 *   S3RCH_LOGIN_PROVIDERS   JSON array. When set, it is the whole list:
 *     [{ "id": "siwe", "kind": "siwe" },
 *      { "id": "panopticon", "kind": "oidc", "label": "...",
 *        "issuer": "https://auth.example.org/realms/controlplane",
 *        "clientId": "s3rch-web",
 *        "walletLookupUrl": "https://api.example.org/auth/siwe/me" }]
 *
 *   When it is unset, the defaults are SIWE plus one OIDC provider with id
 *   "panopticon" built from:
 *     S3RCH_OAUTH_ISSUER       issuer URL; unset means no OIDC sign-in
 *     S3RCH_OAUTH_CLIENT_ID    defaults to "s3rch-web"
 *     S3RCH_OAUTH_WALLET_URL   optional bound-wallet lookup
 *
 * Issuer and wallet URLs must be https, or http on localhost / 127.0.0.1.
 * An invalid entry is dropped (fails closed) and reported by
 * readLoginProviders().errors. No issuer host is built in.
 *
 * Endpoints follow the Keycloak layout under the issuer
 * (`/protocol/openid-connect/{auth,token,certs}`) unless the entry sets
 * authorizationEndpoint, tokenEndpoint and jwksUri.
 *
 * OIDC subjects are namespaced as `<id>:<sub>` so two providers cannot claim
 * the same subject. The provider with id "panopticon" keeps bare subjects,
 * which is how existing account links were stored.
 */

import { createHash } from "node:crypto";
import { OAUTH_CLIENT_ID } from "./config";

export type EnvLike = Record<string, string | undefined>;

export type SiweProvider = { id: string; kind: "siwe"; label: string };

export type OidcProvider = {
  id: string;
  kind: "oidc";
  label: string;
  issuer: string;
  clientId: string;
  walletLookupUrl: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};

export type LoginProvider = SiweProvider | OidcProvider;

export const DEFAULT_OIDC_PROVIDER_ID = "panopticon";
export const SIWE_PROVIDER: SiweProvider = { id: "siwe", kind: "siwe", label: "Wallet" };

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// OAuth client ids are opaque: any visible ASCII, no spaces.
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
const LABEL_MAX = 64;

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** https, or http on loopback. No credentials, query or fragment. Trailing slashes removed. */
export function normalizeProviderUrl(raw: unknown): string | null {
  const exact = exactProviderUrl(raw);
  return exact === null ? null : exact.replace(/\/+$/, "");
}

/** Same checks, but the value is kept as written (OIDC issuers compare exactly). */
export function exactProviderUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) return null;
  return raw.trim();
}

function cleanLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const label = raw.trim().replace(/\s+/g, " ");
  return label && label.length <= LABEL_MAX ? label : fallback;
}

function oidcFrom(
  row: Record<string, unknown>,
  id: string,
  options: { trimIssuer?: boolean } = {},
): OidcProvider | string {
  if (id === SIWE_PROVIDER.id) return `provider "${id}": the id "siwe" is reserved for wallet sign-in`;
  const issuer = options.trimIssuer ? normalizeProviderUrl(row.issuer) : exactProviderUrl(row.issuer);
  if (!issuer) return `provider "${id}": issuer must be an https URL`;
  const base = issuer.replace(/\/+$/, "");
  const clientId = row.clientId === undefined ? OAUTH_CLIENT_ID : row.clientId;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return `provider "${id}": invalid clientId`;
  let walletLookupUrl: string | null = null;
  if (row.walletLookupUrl !== undefined && row.walletLookupUrl !== null && row.walletLookupUrl !== "") {
    walletLookupUrl = exactProviderUrl(row.walletLookupUrl);
    if (!walletLookupUrl) return `provider "${id}": walletLookupUrl must be an https URL`;
  }
  const endpoints = {
    authorizationEndpoint: `${base}/protocol/openid-connect/auth`,
    tokenEndpoint: `${base}/protocol/openid-connect/token`,
    jwksUri: `${base}/protocol/openid-connect/certs`,
  };
  for (const key of Object.keys(endpoints) as (keyof typeof endpoints)[]) {
    if (row[key] === undefined) continue;
    // Explicit endpoints are used exactly as written.
    const value = exactProviderUrl(row[key]);
    if (!value) return `provider "${id}": ${key} must be an https URL`;
    endpoints[key] = value;
  }
  return {
    id,
    kind: "oidc",
    label: cleanLabel(row.label, id),
    issuer,
    clientId,
    walletLookupUrl,
    ...endpoints,
  };
}

function defaultProviders(env: EnvLike): { providers: LoginProvider[]; errors: string[] } {
  const providers: LoginProvider[] = [SIWE_PROVIDER];
  const errors: string[] = [];
  const issuer = env.S3RCH_OAUTH_ISSUER?.trim();
  if (!issuer) return { providers, errors };
  const built = oidcFrom(
    {
      issuer,
      clientId: env.S3RCH_OAUTH_CLIENT_ID?.trim() || undefined,
      walletLookupUrl: env.S3RCH_OAUTH_WALLET_URL?.trim() || undefined,
      label: "Panopticon",
    },
    DEFAULT_OIDC_PROVIDER_ID,
    // Keycloak issuers have no trailing slash; keep accepting `.../realm/`.
    { trimIssuer: true },
  );
  if (typeof built === "string") errors.push(built);
  else providers.push(built);
  return { providers, errors };
}

export function readLoginProviders(env: EnvLike = process.env): { providers: LoginProvider[]; errors: string[] } {
  const raw = env.S3RCH_LOGIN_PROVIDERS?.trim();
  if (!raw) return defaultProviders(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { providers: [SIWE_PROVIDER], errors: ["S3RCH_LOGIN_PROVIDERS is not valid JSON"] };
  }
  if (!Array.isArray(parsed)) {
    return { providers: [SIWE_PROVIDER], errors: ["S3RCH_LOGIN_PROVIDERS must be a JSON array"] };
  }
  const providers: LoginProvider[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      errors.push("provider entry must be an object");
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!PROVIDER_ID.test(id)) {
      errors.push(`provider id ${JSON.stringify(row.id)} is invalid`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`provider "${id}" is listed twice`);
      continue;
    }
    if (row.kind === "siwe") {
      if (id !== SIWE_PROVIDER.id) {
        errors.push(`provider "${id}": a siwe entry must use the id "siwe"`);
        continue;
      }
      seen.add(id);
      providers.push({ id, kind: "siwe", label: cleanLabel(row.label, SIWE_PROVIDER.label) });
      continue;
    }
    if (row.kind !== "oidc") {
      errors.push(`provider "${id}": kind must be "siwe" or "oidc"`);
      continue;
    }
    const built = oidcFrom(row, id);
    if (typeof built === "string") {
      errors.push(built);
      continue;
    }
    seen.add(id);
    providers.push(built);
  }
  // The wallet owns the account. SIWE cannot be configured away.
  if (!providers.some((provider) => provider.kind === "siwe")) {
    providers.unshift(SIWE_PROVIDER);
    errors.push("SIWE is always enabled; added it to the provider list");
  }
  return { providers, errors };
}

export function oidcProviders(env: EnvLike = process.env): OidcProvider[] {
  return readLoginProviders(env).providers.filter((p): p is OidcProvider => p.kind === "oidc");
}

/** No id: the first OIDC provider. Unknown id: null. */
export function findOidcProvider(env: EnvLike, id?: string | null): OidcProvider | null {
  const list = oidcProviders(env);
  if (!id) return list[0] ?? null;
  return list.find((provider) => provider.id === id) ?? null;
}

const SUBJECT_MAX = 256;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Marks a hashed key. encodeURIComponent never emits "%h" (h is not hex). */
const HASH_MARK = "%h";

/**
 * Account key for a provider subject. Total and injective:
 *
 * - Default provider (`panopticon`), subject with no ":", no whitespace, not
 *   address-shaped and at most 256 characters: the subject itself. This is
 *   how every existing account link was stored (Keycloak UUIDs), so those
 *   keys do not change.
 * - Anything else: `<provider id>:<encodeURIComponent(subject)>`. Provider
 *   ids cannot contain ":", so the prefix names exactly one provider, and
 *   plain default keys never contain ":", so they cannot equal a namespaced
 *   key. encodeURIComponent escapes ":", "%" and whitespace and is reversible
 *   (see decodeProviderSubject).
 * - When that key would exceed 256 characters (the store limit):
 *   `<provider id>:%h<sha256(subject), base64url>`. Encoded subjects never
 *   contain "%h", so a hashed key cannot equal an encoded one. Stable, not
 *   reversible.
 */
export function providerSubject(provider: Pick<OidcProvider, "id">, sub: string): string {
  if (
    provider.id === DEFAULT_OIDC_PROVIDER_ID &&
    !sub.includes(":") &&
    !/\s/.test(sub) &&
    !ADDRESS.test(sub) &&
    sub.length <= SUBJECT_MAX
  ) {
    return sub;
  }
  const encoded = `${provider.id}:${encodeURIComponent(sub)}`;
  if (encoded.length <= SUBJECT_MAX) return encoded;
  return `${provider.id}:${HASH_MARK}${createHash("sha256").update(sub, "utf8").digest("base64url")}`;
}

/** Inverse of providerSubject. Hashed keys return `sub: null`. */
export function decodeProviderSubject(key: string): { provider: string; sub: string | null } {
  const cut = key.indexOf(":");
  if (cut < 0) return { provider: DEFAULT_OIDC_PROVIDER_ID, sub: key };
  const provider = key.slice(0, cut);
  const rest = key.slice(cut + 1);
  if (rest.startsWith(HASH_MARK)) return { provider, sub: null };
  return { provider, sub: decodeURIComponent(rest) };
}

/** Public list for the sign-in UI. No client ids or endpoints. */
export function publicLoginProviders(env: EnvLike = process.env): { id: string; kind: string; label: string }[] {
  return readLoginProviders(env).providers.map(({ id, kind, label }) => ({ id, kind, label }));
}
