/**
 * Backup OAuth door. Any configured OIDC provider (see providers.ts); the
 * default is a Keycloak realm with the public PKCE client `s3rch-web`.
 *
 * The SIWE cookie stays the session subject for Gun and Check. The forum
 * owner is the sociacl checksummed address after a handle resolves. This
 * cookie is a separate backup session. It stores the Keycloak `sub` and
 * which broker was used. It does not store access tokens, refresh tokens,
 * or the id token. Nothing here is written to Gun.
 *
 * Unlinked OAuth is not an owner. A SIWE session and this cookie can bind
 * both ways onto one sociacl owner (the checksummed address). The binding
 * is not this cookie and is not written to Gun.
 * Missing or invalid provider config fails closed.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import { getAddress } from "viem";
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_ID,
  OAUTH_PKCE_TTL_SECONDS,
  OAUTH_REDIRECT_URIS,
  SESSION_TTL_SECONDS,
} from "./config";
import { AGE_CONFIRMATION_REQUIRED } from "./age";
import {
  cookieOptions,
  oauthAgeCookieName,
  oauthAgeCookieNames,
  oauthPkceCookieName,
  oauthPkceCookieNames,
  oauthSessionCookieName,
  oauthSessionCookieNames,
  readCookie,
  requestHost,
  requestIsSecure,
  serializeCookie,
  sessionCookieNames,
} from "./cookies";
import { identityUnavailableResponse, secretFailureResponse } from "./http";
import { getLinks, identityLinksWritable, linkLoginPaths, ownerForOAuth } from "./link";
import {
  approvedIssuerMove,
  DEFAULT_OIDC_PROVIDER_ID,
  findOidcProvider,
  oidcProviders,
  providerSubject,
  type OidcProvider,
} from "./providers";
import { getIdentitySecret, secretKey } from "./secret";
import { readSessionToken } from "./session";

export const OAUTH_IDPS = ["microsoft", "github", "google"] as const;
export type OAuthIdp = (typeof OAUTH_IDPS)[number];

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
  /** Checksummed address from Panopticon `GET /auth/siwe/me`. Not a key. */
  hypermeshWallet: string | null;
  iat: number;
  exp: number;
};

type PkcePending = {
  state: string;
  verifier: string;
  redirectUri: string;
  idp: OAuthIdp | null;
  /** Provider id. Absent on cookies issued before providers were configurable. */
  provider: string | null;
};

type EnvLike = Record<string, string | undefined>;

export type OAuthDeps = {
  fetchImpl?: typeof fetch;
  /** Reads `GET /auth/siwe/me`. Omitted in tests that only mock the token exchange. */
  walletFetch?: typeof fetch;
  key?: JWTVerifyGetKey | Uint8Array | CryptoKey;
  now?: number;
};

/** Issuer of the default OIDC provider, or null when none is configured. */
export function readOAuthIssuer(env: EnvLike = process.env): string | null {
  return findOidcProvider(env)?.issuer ?? null;
}

function parseProviderParam(raw: string | null): string | null | "invalid" {
  if (raw === null || raw === "") return null;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(raw) ? raw : "invalid";
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
  clientId?: string;
  authorizationEndpoint?: string;
}): string {
  const url = new URL(input.authorizationEndpoint ?? `${input.issuer}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", input.clientId ?? OAUTH_CLIENT_ID);
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

/** Raw `sub` from a provider token. Opaque; only empty, huge or control characters are refused. */
function rawProviderSub(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OAuthFlowError("OAuth subject is missing.");
  }
  return value;
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
    provider: pending.provider ?? "",
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
    provider: typeof payload.provider === "string" && payload.provider ? payload.provider : null,
  };
}

export async function signBackupSession(
  input: { sub: string; idp: OAuthIdp | null; hypermeshWallet?: string | null },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const sub = assertSub(input.sub);
  const iat = Math.floor(now / 1000);
  const hypermeshWallet = input.hypermeshWallet ? getAddress(input.hypermeshWallet) : undefined;
  return new SignJWT({
    kind: "oauth-backup",
    idp: input.idp ?? "",
    ...(hypermeshWallet ? { hypermeshWallet } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(secretKey(secret));
}

async function signAgePending(
  input: { sub: string; idp: OAuthIdp | null; hypermeshWallet?: string | null },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const sub = assertSub(input.sub);
  const iat = Math.floor(now / 1000);
  const hypermeshWallet = input.hypermeshWallet ? getAddress(input.hypermeshWallet) : undefined;
  return new SignJWT({
    kind: "oauth-age",
    idp: input.idp ?? "",
    ...(hypermeshWallet ? { hypermeshWallet } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + OAUTH_PKCE_TTL_SECONDS)
    .sign(secretKey(secret));
}

async function readAgePending(token: string, secret: string): Promise<BackupSession> {
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
  if (payload.kind !== "oauth-age") throw new OAuthFlowError("Age confirmation is invalid.");
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new OAuthFlowError("Age confirmation is invalid.");
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  return {
    sub: assertSub(sub),
    idp: asIdp(payload.idp),
    hypermeshWallet: checksumWallet(payload.hypermeshWallet),
    iat: payload.iat,
    exp: payload.exp,
  };
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
    hypermeshWallet: checksumWallet(payload.hypermeshWallet),
    iat: payload.iat,
    exp: payload.exp,
  };
}

function checksumWallet(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

/**
 * One read of the wallet the provider has bound to this account, from the
 * provider's `walletLookupUrl` (expects `{ bound, wallet_address }`). The
 * access token is not stored. No URL or any failure is no wallet.
 */
export async function lookupProviderWallet(input: {
  url: string | null;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  const url = input.url;
  if (!url || !input.accessToken || input.accessToken.length > 8192) return null;
  try {
    const response = await input.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { bound?: unknown; wallet_address?: unknown };
    if (json.bound !== true) return null;
    return checksumWallet(json.wallet_address);
  } catch {
    return null;
  }
}

async function exchangeCode(
  input: {
    issuer: string;
    code: string;
    verifier: string;
    redirectUri: string;
    clientId?: string;
    tokenEndpoint?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ idToken: string; accessToken: string | null }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId ?? OAUTH_CLIENT_ID,
    code_verifier: input.verifier,
  });
  let response: Response;
  try {
    response = await fetchImpl(input.tokenEndpoint ?? `${input.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthFlowError("Token exchange failed.");
  }
  if (!response.ok) throw new OAuthFlowError("Token exchange failed.");
  let json: { id_token?: unknown; access_token?: unknown };
  try {
    json = (await response.json()) as { id_token?: unknown; access_token?: unknown };
  } catch {
    throw new OAuthFlowError("Token exchange failed.");
  }
  if (typeof json.id_token !== "string" || !json.id_token) {
    throw new OAuthFlowError("Token exchange failed.");
  }
  const accessToken =
    typeof json.access_token === "string" && json.access_token ? json.access_token : null;
  return { idToken: json.id_token, accessToken };
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
  return (await exchangeCode(input, fetchImpl)).idToken;
}

function jwksFor(jwksUri: string): JWTVerifyGetKey {
  const existing = jwksByIssuer.get(jwksUri);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(jwksUri));
  jwksByIssuer.set(jwksUri, created);
  return created;
}

export async function verifyBackupIdToken(
  idToken: string,
  input: {
    issuer: string;
    key: JWTVerifyGetKey | Uint8Array | CryptoKey;
    clientId?: string;
  },
): Promise<{ sub: string; idp: OAuthIdp | null }> {
  const { payload } = await jwtVerify(idToken, input.key, {
    issuer: input.issuer,
    audience: input.clientId ?? OAUTH_CLIENT_ID,
    algorithms: ["RS256", "PS256", "ES256"],
  });
  return {
    sub: rawProviderSub(payload.sub),
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

function clearAge(secure: boolean): string[] {
  return [
    clearCookie(oauthAgeCookieName(secure), secure),
    clearCookie(oauthAgeCookieName(!secure), !secure),
  ];
}

async function linkedWalletAddress(request: Request, secret: string): Promise<string | null> {
  const siwe = readCookie(request.headers.get("cookie"), sessionCookieNames());
  if (!siwe) return null;
  try {
    return (await readSessionToken(siwe, secret)).address;
  } catch {
    return null;
  }
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

  const params = new URL(request.url).searchParams;
  const requested = parseProviderParam(params.get("provider"));
  if (requested === "invalid") return appRedirect("/feed?oauth=denied");
  if (oidcProviders(env).length === 0) return appRedirect("/feed?oauth=unconfigured");
  // Links without ?provider= predate configurable providers and carry
  // Panopticon broker hints, so they only go to the default provider.
  const provider = findOidcProvider(env, requested ?? DEFAULT_OIDC_PROVIDER_ID);
  if (!provider) return appRedirect("/feed?oauth=denied");

  const secure = requestIsSecure(request);
  const redirectUri = callbackUriFor(requestHost(request), secure);
  if (!redirectUri) return appRedirect("/feed?oauth=denied");

  const idp = parseIdpHint(params.get("idp"));
  if (idp === "invalid") return appRedirect("/feed?oauth=denied");

  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(32).toString("base64url");
  const pkce = await signPkce({ state, verifier, redirectUri, idp, provider: provider.id }, secret, now);
  const location = buildAuthorizeUrl({
    issuer: provider.issuer,
    redirectUri,
    state,
    challenge,
    idp,
    clientId: provider.clientId,
    authorizationEndpoint: provider.authorizationEndpoint,
  });
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

  if (oidcProviders(env).length === 0) return appRedirect("/feed?oauth=unconfigured", clearPkce(secure));

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

  // A PKCE cookie from before providers were configurable belongs to the
  // default provider, never to whichever provider is listed first now.
  const provider: OidcProvider | null = findOidcProvider(env, pending.provider ?? DEFAULT_OIDC_PROVIDER_ID);
  if (!provider) return denied();
  const issuer = provider.issuer;

  try {
    const exchanged = await exchangeCode(
      {
        issuer,
        code,
        verifier: pending.verifier,
        redirectUri,
        clientId: provider.clientId,
        tokenEndpoint: provider.tokenEndpoint,
      },
      deps.fetchImpl,
    );
    const token = await verifyBackupIdToken(exchanged.idToken, {
      issuer,
      key: deps.key ?? jwksFor(provider.jwksUri),
      clientId: provider.clientId,
    });
    if (!pinIssuer(env, provider)) throw new OAuthFlowError("Login provider issuer changed.");
    // Any subject shape is accepted; providerSubject encodes it into a key
    // that cannot collide with another provider's.
    const subject = providerSubject(provider, token.sub);
    const verified = { ...token, sub: subject };
    const idp = verified.idp ?? pending.idp;
    const walletFetch = deps.walletFetch ?? (deps.fetchImpl ? undefined : fetch);
    const hypermeshWallet =
      exchanged.accessToken && walletFetch
        ? await lookupProviderWallet({
            url: provider.walletLookupUrl,
            accessToken: exchanged.accessToken,
            fetchImpl: walletFetch,
          })
        : null;
    const wallet = await linkedWalletAddress(request, secret);
    const age = getLinks().ageStatusForOAuth(verified.sub, wallet);
    if ("unavailable" in age) throw new OAuthFlowError("Identity store unavailable.");
    if ("needs" in age) {
      const pending = await signAgePending(
        { sub: verified.sub, idp, hypermeshWallet },
        secret,
        deps.now,
      );
      return appRedirect("/feed?oauth=age", [
        serializeCookie(
          oauthAgeCookieName(secure),
          pending,
          cookieOptions(secure, OAUTH_PKCE_TTL_SECONDS),
        ),
        ...clearPkce(secure),
      ]);
    }
    const session = await signBackupSession(
      { sub: verified.sub, idp, hypermeshWallet },
      secret,
      deps.now,
    );
    const location = await linkWalletOnCallback(request, secret, verified.sub, idp);
    return appRedirect(location, [
      serializeCookie(
        oauthSessionCookieName(secure),
        session,
        cookieOptions(secure, SESSION_TTL_SECONDS),
      ),
      ...clearPkce(secure),
      ...clearAge(secure),
    ]);
  } catch {
    return denied();
  }
}

/**
 * Pins the provider's issuer in the identity store on first use and refuses
 * logins when the configured issuer no longer matches the pin, so repointing a
 * provider id at another issuer cannot take over that provider's accounts.
 * An operator approves a move with S3RCH_LOGIN_PROVIDER_ISSUER_MOVE.
 */
function pinIssuer(env: Record<string, string | undefined>, provider: OidcProvider): boolean {
  const issuer = provider.issuer.replace(/\/+$/, "");
  const result = getLinks().checkProviderIssuer(provider.id, issuer, approvedIssuerMove(env, provider.id));
  if ("denied" in result) return false;
  if (!result.ok) {
    console.error(
      `s3r.ch: login provider "${provider.id}" refused: configured issuer ${issuer} differs from pinned ${result.pinned}. ` +
        `Set S3RCH_LOGIN_PROVIDER_ISSUER_MOVE=${provider.id}:${issuer} to approve the move.`,
    );
    return false;
  }
  if (result.pinned === "moved") {
    console.warn(`s3r.ch: login provider "${provider.id}" issuer moved from ${result.previous} to ${issuer} (approved by S3RCH_LOGIN_PROVIDER_ISSUER_MOVE).`);
  } else if (result.pinned === "first-use") {
    console.info(`s3r.ch: login provider "${provider.id}" issuer pinned to ${issuer}.`);
  }
  return true;
}

async function linkWalletOnCallback(
  request: Request,
  secret: string,
  sub: string,
  idp: OAuthIdp | null,
): Promise<string> {
  const wallet = await linkedWalletAddress(request, secret);
  if (!wallet) return "/feed";
  try {
    const bound = linkLoginPaths({ wallet, sub, idp });
    if ("denied" in bound && bound.reason === "already-linked") return "/feed?oauth=conflict";
  } catch {
    return "/feed";
  }
  return "/feed";
}

/** Issues the backup session only after the age confirmation is stored. */
export async function acceptOAuthAge(
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

  let body: { ageConfirmed?: unknown };
  try {
    body = (await request.json()) as { ageConfirmed?: unknown };
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }
  if (body.ageConfirmed !== true) {
    return Response.json({ error: AGE_CONFIRMATION_REQUIRED }, { status: 403 });
  }

  const pendingToken = readCookie(request.headers.get("cookie"), oauthAgeCookieNames());
  if (!pendingToken) return Response.json({ error: "unauthorized" }, { status: 401 });
  let pending: BackupSession;
  try {
    pending = await readAgePending(pendingToken, secret);
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!identityLinksWritable()) return identityUnavailableResponse();
  const saved = getLinks().saveOAuthAge(pending.sub, new Date(now).toISOString());
  if ("denied" in saved) {
    if (saved.reason === "store-unreadable") return identityUnavailableResponse();
    return Response.json({ error: saved.reason }, { status: 400 });
  }

  const wallet = await linkedWalletAddress(request, secret);
  let linked = false;
  let conflict = false;
  let owner = ownerForOAuth(pending.sub);
  if (wallet) {
    const bound = linkLoginPaths({ wallet, sub: pending.sub, idp: pending.idp });
    if (!("denied" in bound)) {
      linked = true;
      owner = bound.owner;
    } else if (bound.reason === "already-linked") {
      conflict = true;
    }
  }

  const session = await signBackupSession(
    { sub: pending.sub, idp: pending.idp, hypermeshWallet: pending.hypermeshWallet },
    secret,
    now,
  );
  const secure = requestIsSecure(request);
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    serializeCookie(oauthSessionCookieName(secure), session, cookieOptions(secure, SESSION_TTL_SECONDS)),
  );
  for (const cookie of [...clearAge(secure), ...clearPkce(secure)]) {
    headers.append("Set-Cookie", cookie);
  }
  return Response.json(
    {
      idp: pending.idp,
      linked,
      conflict,
      owner,
      hypermeshWallet: pending.hypermeshWallet,
    },
    { headers },
  );
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
