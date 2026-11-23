import { timingSafeEqual } from "node:crypto";

const originId = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** TEST Container Apps authenticate the existing Cloudflare origin header in-process. */
export function testOriginAllowed(
  expected: string | undefined,
  received: unknown,
  http?: { method: string | undefined; pathname: string },
): boolean {
  if (expected === undefined) return true;
  if (!originId.test(expected)) return false;
  if (http?.method === "GET" && http.pathname === "/api/health") return true;
  return typeof received === "string" && originId.test(received) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
