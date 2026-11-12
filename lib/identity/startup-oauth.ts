import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import { requestHost, requestIsSecure } from "../request-origin";
import { cookieOptions, readCookie, serializeCookie, oauthPkceCookieName } from "./cookies";
import { startupPendingName, startupCredentialName } from "./startup-login-cookies";
import { callbackUriFor, createPkcePair, exchangeCode } from "./oauth";
import { getIdentitySecret, secretKey } from "./secret";
import { readStartupLoginConfig, type StartupLoginConfig } from "./startup-login-config";
import { createStartupIdentityClient } from "./startup-identity-client";
import { resolveStartupLinkedIdentity } from "./startup-linked-login";

type Env = Record<string, string | undefined>;
type Dependencies = { config?: () => Promise<StartupLoginConfig | null>; fetch?: typeof fetch;
  key?: JWTVerifyGetKey | Uint8Array | CryptoKey; now?: number };
const pendingKind = "s3rch-startup-pkce-v1", credentialKind = "s3rch-startup-credential-v1";
const ttl = 300;
const jwks = new Map<string, JWTVerifyGetKey>();
const clear = (name: string) => serializeCookie(name, "", cookieOptions(name.startsWith("__Host-"), 0));
const clearPending = () => [clear(startupPendingName(true)), clear(startupPendingName(false))];
const clearCredential = () => [clear(startupCredentialName(true)), clear(startupCredentialName(false))];
const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
};
function same(a: unknown, b: unknown) {
  return typeof a === "string" && typeof b === "string" && a.length <= 512 && b.length <= 512 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function origin(request: Request) {
  const callback = callbackUriFor(requestHost(request), requestIsSecure(request));
  if (!callback) throw Error("Unavailable callback");
  return { callback, origin: new URL(callback).origin };
}
async function sign(kind: string, payload: Record<string, unknown>, request: Request, secret: string, now: number) {
  const scope = origin(request).origin;
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: kind })
    .setIssuer(scope).setAudience(scope).setIssuedAt(now).setExpirationTime(now + ttl).sign(secretKey(secret));
}
async function verify(token: string, kind: string, request: Request, secret: string, now: number) {
  if (token.length > 4096) throw Error("Invalid credential");
  const scope = origin(request).origin;
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"], typ: kind,
    issuer: scope, audience: scope, currentDate: new Date(now * 1000), requiredClaims: ["iat", "exp"] });
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now || payload.exp! - payload.iat! !== ttl) throw Error("Invalid credential");
  return payload;
}
export function hasStartupPending(request: Request) {
  return !!readCookie(request.headers.get("cookie"), [startupPendingName(true), startupPendingName(false)]);
}

export async function beginStartupOAuth(request: Request, env: Env = process.env, deps: Dependencies = {}) {
  try {
    const config = await (deps.config?.() ?? readStartupLoginConfig(env));
    if (!config) return redirect("/feed?startup=unavailable", [...clearPending(), ...clearCredential()]);
    const secret = getIdentitySecret(env), now = Math.floor((deps.now ?? Date.now()) / 1000);
    const { verifier, challenge } = createPkcePair(), state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
    const { callback } = origin(request);
    const token = await sign(pendingKind, { state, nonce, verifier, callback, mapping: config.binding.mapping_sha256 }, request, secret, now);
    const url = new URL(config.provider.authorizationEndpoint);
    for (const [name, value] of Object.entries({ client_id: config.provider.clientId, redirect_uri: callback,
      response_type: "code", scope: "openid", state, nonce, code_challenge: challenge,
      code_challenge_method: "S256", kc_idp_hint: config.alias })) url.searchParams.set(name, value);
    const secure = requestIsSecure(request);
    return redirect(url.href, [...clearPending(), ...clearCredential(), clear(oauthPkceCookieName(true)), clear(oauthPkceCookieName(false)),
      serializeCookie(startupPendingName(secure), token, cookieOptions(secure, ttl))]);
  } catch { return redirect("/feed?startup=unavailable", [...clearPending(), ...clearCredential()]); }
}

export async function finishStartupOAuth(request: Request, env: Env = process.env, deps: Dependencies = {}) {
  const denied = () => redirect("/feed?startup=denied", [...clearPending(), ...clearCredential()]);
  try {
    const config = await (deps.config?.() ?? readStartupLoginConfig(env));
    if (!config) return denied();
    const secret = getIdentitySecret(env), now = Math.floor((deps.now ?? Date.now()) / 1000);
    const cookie = readCookie(request.headers.get("cookie"), [startupPendingName(true), startupPendingName(false)]);
    if (!cookie) return denied();
    const pending = await verify(cookie, pendingKind, request, secret, now), params = new URL(request.url).searchParams;
    const code = params.get("code");
    if (params.has("error") || !code || code.length > 2048 || !same(params.get("state"), pending.state) ||
        pending.mapping !== config.binding.mapping_sha256 || pending.callback !== origin(request).callback ||
        typeof pending.verifier !== "string" || typeof pending.nonce !== "string") return denied();
    const exchanged = await exchangeCode({ issuer: config.provider.issuer, clientId: config.provider.clientId,
      tokenEndpoint: config.provider.tokenEndpoint, code, verifier: pending.verifier, redirectUri: pending.callback }, deps.fetch);
    let key = deps.key;
    if (!key) {
      if (!jwks.has(config.provider.jwksUri)) jwks.set(config.provider.jwksUri, createRemoteJWKSet(new URL(config.provider.jwksUri)));
      key = jwks.get(config.provider.jwksUri)!;
    }
    const { payload } = await jwtVerify(exchanged.idToken, key, { algorithms: ["RS256", "PS256", "ES256"],
      issuer: config.provider.issuer, audience: config.provider.clientId, currentDate: new Date(now * 1000), requiredClaims: ["sub", "exp", "iat", "nonce"] });
    if (!Number.isSafeInteger(payload.iat) || payload.iat! > now || !Number.isSafeInteger(payload.exp) || !same(payload.nonce, pending.nonce) || typeof payload.sub !== "string" || !exchanged.accessToken ||
        (payload.azp !== undefined && payload.azp !== config.provider.clientId)) return denied();
    const identity = await createStartupIdentityClient({ endpoint: config.endpoint, expected: config.binding, fetch: deps.fetch })
      .resolve(exchanged.accessToken, payload.sub, { sea_public_key: config.binding.sea_public_key });
    if (!identity) return denied();
    const latest = await (deps.config?.() ?? readStartupLoginConfig(env));
    if (!latest || latest.binding.mapping_sha256 !== config.binding.mapping_sha256 ||
        latest.provider.id !== config.provider.id || latest.endpoint !== config.endpoint) return denied();
    const finishedAt = Math.floor((deps.now ?? Date.now()) / 1000);
    await verify(cookie, pendingKind, request, secret, finishedAt);
    if (payload.exp! <= finishedAt) return denied();
    // The cookie confirms linked credentials only. It grants no mesh or owner action.
    const token = await sign(credentialKind, { identity }, request, secret, finishedAt);
    if (token.length > 3800) return denied();
    const secure = requestIsSecure(request);
    return redirect("/feed?startup=linked", [...clearPending(),
      serializeCookie(startupCredentialName(secure), token, cookieOptions(secure, ttl))]);
  } catch { return denied(); }
}

export async function readStartupCredential(request: Request, env: Env = process.env, deps: Dependencies = {}) {
  try {
    const config = await (deps.config?.() ?? readStartupLoginConfig(env));
    if (!config) return null;
    const cookie = readCookie(request.headers.get("cookie"), [startupCredentialName(true), startupCredentialName(false)]);
    if (!cookie) return null;
    const payload = await verify(cookie, credentialKind, request, getIdentitySecret(env), Math.floor((deps.now ?? Date.now()) / 1000));
    const saved = payload.identity;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
    const row = saved as Record<string, unknown>;
    const identity = resolveStartupLinkedIdentity({ ...row, schema_version: 1, status: "resolved", permissions: [] }, config.binding,
      typeof row.broker_subject === "string" ? row.broker_subject : "", { sea_public_key: config.binding.sea_public_key });
    return identity ? { binding: config.binding, identity: { ...identity, schema_version: 1, status: "resolved", permissions: [] }, verifiedSubject: identity.broker_subject, expiresAt: payload.exp! * 1000 } : null;
  } catch { return null; }
}
