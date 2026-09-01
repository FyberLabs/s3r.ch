import { COOKIE_BASE } from "./config";

export type CookieOpts = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function requestHost(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "";
  return request.headers.get("host") ?? new URL(request.url).host;
}

/**
 * Strongest prefix that works: `__Host-` on HTTPS (s3r.ch).
 * HTTP localhost cannot set `__Host-` (Secure is required), so `Host-`.
 */
export function cookiePrefix(secure: boolean): "__Host-" | "Host-" {
  return secure ? "__Host-" : "Host-";
}

export function nonceCookieName(secure: boolean): string {
  return `${cookiePrefix(secure)}${COOKIE_BASE.nonce}`;
}

export function sessionCookieName(secure: boolean): string {
  return `${cookiePrefix(secure)}${COOKIE_BASE.session}`;
}

export function nonceCookieNames(): string[] {
  return [nonceCookieName(true), nonceCookieName(false)];
}

export function sessionCookieNames(): string[] {
  return [sessionCookieName(true), sessionCookieName(false)];
}

export function cookieOptions(secure: boolean, maxAge: number): CookieOpts {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

export function readCookie(
  cookieHeader: string | null,
  names: readonly string[],
): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";");
  const wanted = new Set(names);
  for (const part of parts) {
    const cut = part.indexOf("=");
    if (cut < 0) continue;
    const name = part.slice(0, cut).trim();
    if (!wanted.has(name)) continue;
    const value = part.slice(cut + 1).trim();
    if (value) return decodeURIComponent(value);
  }
  return undefined;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOpts,
): string {
  const pieces = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) pieces.push("Secure");
  return pieces.join("; ");
}
