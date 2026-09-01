import { cookies } from "next/headers";
import {
  cookieOptions,
  nonceCookieName,
  nonceCookieNames,
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
  ];
  for (const name of names) {
    const secure = name.startsWith("__Host-");
    jar.set(name, "", cookieOptions(secure, 0));
  }
}
