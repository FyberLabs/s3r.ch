/**
 * Backup OAuth door. Panopticon Keycloak, public PKCE client `s3rch-web`.
 *
 * The SIWE cookie stays the session subject for Gun, Check, and the forum
 * owner. This cookie is a separate backup session. It stores the Keycloak
 * `sub` and which broker was used. It does not store access tokens, refresh
 * tokens, or the id token. Nothing here is written to Gun.
 *
 * Unlinked OAuth is not an owner. SIWE link binding is a later slice.
 * Missing or unknown issuer config fails closed.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_ID,
  OAUTH_PKCE_TTL_SECONDS,
  OAUTH_REDIRECT_URIS,
  SESSION_TTL_SECONDS,
} from "./config";
import {
  cookieOptions,
  oauthPkceCookieName,
  oauthPkceCookieNames,
  oauthSessionCookieName,
  oauthSessionCookieNames,
  readCookie,
  requestHost,
  requestIsSecure,
  serializeCookie,
} from "./cookies";
import { secretFailureResponse } from "./http";
import { getIdentitySecret, secretKey } from "./secret";

export const OAUTH_IDPS = ["microsoft", "github", "google"] as const;
export type OAuthIdp = (typeof OAUTH_IDPS)[number];

/** Issuers this app will send a browser to. Anything else fails closed. */
export const ALLOWED_OAUTH_ISSUERS = [
  "https://auth.test.hyperme.sh/realms/controlplane",
  "https://auth.hyperme.sh/realms/controlplane",
  "http://localhost:8081/realms/controlplane",
  "http://127.0.0.1:8081/realms/controlplane",
] as const;

const SUB_MAX = 256;
const CODE_MAX = 2048;
const STATE_MAX = 128;

const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

export type BackupSession = {
  sub: string;
  idp: OAuthIdp | null;
  iat: number;
  exp: number;
};

type PkcePending = {
  state: string;
  verifier: string;
  redirectUri: string;
  idp: OAuthIdp | null;
};

type EnvLike = {
  S3RCH_OAUTH_ISSUER?: string;
  IDENTITY_SESSION_SECRET?: string;
  NODE_ENV?: string;
};

export type OAuthDeps = {
  fetchImpl?: typeof fetch;
  key?: JWTVerifyGetKey | Uint8Array | CryptoKey;
  now?: number;
};

export function readOAuthIssuer(env: EnvLike = process.env): string | null {
  const raw = env.S3RCH_OAUTH_ISSUER?.trim() ?? "";
  if (!raw) return null;
  const normalized = raw.replace(/\/+$/, "");
  if (!(ALLOWED_OAUTH_ISSUERS as readonly string[]).includes(normalized)) return null;
  return normalized;
}

export function callbackUriFor(host: string, secure: boolean): string | null {
  if (!host || host.includes("/") || host.includes("@")) return null;
  const uri = `${secure ? "https" : "http"}://${host}${OAUTH_CALLBACK_PATH}`;
  if (!(OAUTH_REDIRECT_URIS as readonly string[]).includes(uri)) return null;
  return uri;
}

export function parseIdpHint(raw: string | null): OAuthIdp | null | "invalid" {
  if (raw === null || raw === "") return null;
  if ((OAUTH_IDPS as readonly string[]).includes(raw)) return raw as OAuthIdp;
  return "invalid";
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: {
  issuer: string;
  redirectUri: string;
  state: string;
  challenge: string;
  idp: OAuthIdp | null;
}): string {
  const url = new URL(`${input.issuer}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.idp) url.searchParams.set("kc_idp_hint", input.idp);
  return url.toString();
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function asIdp(value: unknown): OAuthIdp | null {
  if (typeof value !== "string" || value === "") return null;
  if ((OAUTH_IDPS as readonly string[]).includes(value)) return value as OAuthIdp;
  return null;
}

function assertSub(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > SUB_MAX) {
    throw new OAuthFlowError("OAuth subject is missing.");
  }
  if (/\s/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new OAuthFlowError("OAuth subject is missing.");
  }
  return value;
}

async function signPkce(pending: PkcePending, secret: string, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({
    kind: "oauth-pkce",
    state: pending.state,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri,
    idp: pending.idp ?? "",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("oauth-pkce")
    .setIssuedAt(iat)
    .setExpirationTime(iat + OAUTH_PKCE_TTL_SECONDS)
    .sign(secretKey(secret));
}

async function readPkce(token: string, secret: string): Promise<PkcePending> {
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
  if (payload.kind !== "oauth-pkce") throw new OAuthFlowError("PKCE cookie is invalid.");
  if (typeof payload.state !== "string" || typeof payload.verifier !== "string") {
    throw new OAuthFlowError("PKCE cookie is invalid.");
  }
  if (typeof payload.redirectUri !== "string") throw new OAuthFlowError("PKCE cookie is invalid.");
  if (!(OAUTH_REDIRECT_URIS as readonly string[]).includes(payload.redirectUri)) {
    throw new OAuthFlowError("PKCE cookie is invalid.");
  }
  return {
    state: payload.state,
    verifier: payload.verifier,
    redirectUri: payload.redirectUri,
    idp: asIdp(payload.idp),
  };
}

export async function signBackupSession(
  input: { sub: string; idp: OAuthIdp | null },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const sub = assertSub(input.sub);
  const iat = Math.floor(now / 1000);
  return new SignJWT({
    kind: "oauth-backup",
    idp: input.idp ?? "",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function readBackupSession(token: string, secret: string): Promise<BackupSession> {
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
  if (payload.kind !== "oauth-backup") throw new OAuthFlowError("Backup session is invalid.");
  if ("address" in payload || "chainId" in payload) {
    throw new OAuthFlowError("Backup session is invalid.");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new OAuthFlowError("Backup session is invalid.");
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  return {
    sub: assertSub(sub),
    idp: asIdp(payload.idp),
    iat: payload.iat,
    exp: payload.exp,
  };
}

export async function exchangeCodeForIdToken(
  input: {
    issuer: string;
    code: string;
    verifier: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: input.verifier,
  });
  let response: Response;
  try {
    response = await fetchImpl(`${input.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthFlowError("Token exchange failed.");
  }
  if (!response.ok) throw new OAuthFlowError("Token exchange failed.");
  let json: { id_token?: unknown };
  try {
    json = (await response.json()) as { id_token?: unknown };
  } catch {
    throw new OAuthFlowError("Token exchange failed.");
  }
  if (typeof json.id_token !== "string" || !json.id_token) {
    throw new OAuthFlowError("Token exchange failed.");
  }
  return json.id_token;
}

function jwksFor(issuer: string): JWTVerifyGetKey {
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  jwksByIssuer.set(issuer, created);
  return created;
}

export async function verifyBackupIdToken(
  idToken: string,
  input: {
    issuer: string;
    key: JWTVerifyGetKey | Uint8Array | CryptoKey;
  },
): Promise<{ sub: string; idp: OAuthIdp | null }> {
  const { payload } = await jwtVerify(idToken, input.key, {
    issuer: input.issuer,
    audience: OAUTH_CLIENT_ID,
    algorithms: ["RS256", "PS256", "ES256"],
  });
  return {
    sub: assertSub(payload.sub),
    idp: asIdp(payload.idp_provider),
  };
}

function appRedirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", cookieOptions(secure, 0));
}

function clearPkce(secure: boolean): string[] {
  return [
    clearCookie(oauthPkceCookieName(secure), secure),
    clearCookie(oauthPkceCookieName(!secure), !secure),
  ];
}

export async function beginOAuth(
  request: Request,
  env: EnvLike = process.env,
  now = Date.now(),
): Promise<Response> {
  let secret: string;
  try {
    secret = getIdentitySecret(env);
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "Identity session is not configured." }, { status: 500 })
    );
  }

  const issuer = readOAuthIssuer(env);
  if (!issuer) return appRedirect("/feed?oauth=unconfigured");

  const secure = requestIsSecure(request);
  const redirectUri = callbackUriFor(requestHost(request), secure);
  if (!redirectUri) return appRedirect("/feed?oauth=denied");

  const idp = parseIdpHint(new URL(request.url).searchParams.get("idp"));
  if (idp === "invalid") return appRedirect("/feed?oauth=denied");

  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(32).toString("base64url");
  const pkce = await signPkce({ state, verifier, redirectUri, idp }, secret, now);
  const location = buildAuthorizeUrl({ issuer, redirectUri, state, challenge, idp });
  return appRedirect(location, [
    serializeCookie(
      oauthPkceCookieName(secure),
      pkce,
      cookieOptions(secure, OAUTH_PKCE_TTL_SECONDS),
    ),
  ]);
}

export async function finishOAuth(
  request: Request,
  env: EnvLike = process.env,
  deps: OAuthDeps = {},
): Promise<Response> {
  let secret: string;
  try {
    secret = getIdentitySecret(env);
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "Identity session is not configured." }, { status: 500 })
    );
  }

  const secure = requestIsSecure(request);
  const denied = () => appRedirect("/feed?oauth=denied", clearPkce(secure));

  const issuer = readOAuthIssuer(env);
  if (!issuer) return appRedirect("/feed?oauth=unconfigured", clearPkce(secure));

  const url = new URL(request.url);
  if (url.searchParams.get("error")) return denied();

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state || code.length > CODE_MAX || state.length > STATE_MAX) return denied();

  const pkceToken = readCookie(request.headers.get("cookie"), oauthPkceCookieNames());
  if (!pkceToken) return denied();

  let pending: PkcePending;
  try {
    pending = await readPkce(pkceToken, secret);
  } catch {
    return denied();
  }
  if (!sameSecret(pending.state, state)) return denied();

  const redirectUri = callbackUriFor(requestHost(request), secure);
  if (!redirectUri || redirectUri !== pending.redirectUri) return denied();

  try {
    const idToken = await exchangeCodeForIdToken(
      { issuer, code, verifier: pending.verifier, redirectUri },
      deps.fetchImpl,
    );
    const verified = await verifyBackupIdToken(idToken, {
      issuer,
      key: deps.key ?? jwksFor(issuer),
    });
    const session = await signBackupSession(
      { sub: verified.sub, idp: verified.idp ?? pending.idp },
      secret,
      deps.now,
    );
    return appRedirect("/feed", [
      serializeCookie(
        oauthSessionCookieName(secure),
        session,
        cookieOptions(secure, SESSION_TTL_SECONDS),
      ),
      ...clearPkce(secure),
    ]);
  } catch {
    return denied();
  }
}

export async function readBackupFromRequest(
  request: Request,
  env: EnvLike = process.env,
): Promise<BackupSession | null> {
  const token = readCookie(request.headers.get("cookie"), oauthSessionCookieNames());
  if (!token) return null;
  const secret = getIdentitySecret(env);
  return readBackupSession(token, secret);
}
