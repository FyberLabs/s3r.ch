import { cookies } from "next/headers";
import {
  confirmCookieName,
  confirmCookieNames,
  cookieOptions,
  nonceCookieName,
  nonceCookieNames,
  oauthAgeCookieName,
  oauthPkceCookieName,
  oauthSessionCookieName,
  readCookie,
  sessionCookieName,
  sessionCookieNames,
} from "./cookies";
import { IdentitySecretError, getIdentitySecret } from "./secret";

export function identitySecretOrThrow(): string {
  return getIdentitySecret();
}

export function secretFailureResponse(error: unknown): Response | null {
  if (!(error instanceof IdentitySecretError)) return null;
  console.error(`[identity] ${error.message} Refusing to run identity routes.`);
  return Response.json(
    { error: "Identity session is not configured." },
    { status: 500 },
  );
}

/** Identity storage is down. Only identity writes see this; the rest of the site keeps working. */
export function identityUnavailableResponse(): Response {
  return Response.json(
    { error: "Account linking is temporarily unavailable. Try again later.", reason: "identity-storage-unavailable" },
    { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
  );
}

export async function readNonceFromRequest(
  request: Request,
): Promise<string | undefined> {
  const header = request.headers.get("cookie");
  return readCookie(header, nonceCookieNames());
}

export async function readSessionFromRequest(
  request: Request,
): Promise<string | undefined> {
  const header = request.headers.get("cookie");
  return readCookie(header, sessionCookieNames());
}

export async function readConfirmFromRequest(
  request: Request,
): Promise<string | undefined> {
  const header = request.headers.get("cookie");
  return readCookie(header, confirmCookieNames());
}

export async function setIdentityCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
): Promise<void> {
  const jar = await cookies();
  jar.set(name, value, cookieOptions(secure, maxAge));
}

export async function clearIdentityCookies(): Promise<void> {
  const jar = await cookies();
  const names = [
    nonceCookieName(true),
    nonceCookieName(false),
    sessionCookieName(true),
    sessionCookieName(false),
    confirmCookieName(true),
    confirmCookieName(false),
    oauthSessionCookieName(true),
    oauthSessionCookieName(false),
    oauthPkceCookieName(true),
    oauthPkceCookieName(false),
    oauthAgeCookieName(true),
    oauthAgeCookieName(false),
  ];
  for (const name of names) {
    const secure = name.startsWith("__Host-");
    jar.set(name, "", cookieOptions(secure, 0));
  }
}
