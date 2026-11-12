import { matchesBrowserOrigin } from "../request-origin";
import type { createIdentitySessions } from "./sea-session";

const sessionCookie = "__Host-s3rch-squad-session";
const challengeCookie = "__Host-s3rch-squad-challenge";
export const seaSessionCookieNames = () => [sessionCookie, challengeCookie] as const;
const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 16384) return null;
  const values = header.split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return value.length <= 4096 && /^[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}
export const readSeaSessionCookie = (request: Request) => readCookie(request, sessionCookie);

/** Deployment supplies the already configured session engine. Nothing here
 * registers routes or defaults an authentication secret or storage backend. */
export function createSeaSessionHandlers(input: { origin: string; sessions: ReturnType<typeof createIdentitySessions> }) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  const { sessions } = input;
  const response = (status: number, body: unknown, cookies: string[] = []) => {
    const headers = new Headers({ "Cache-Control": "no-store", Vary: "Cookie, Origin", "X-Content-Type-Options": "nosniff" });
    for (const value of cookies) headers.append("Set-Cookie", value);
    return Response.json(body, { status, headers });
  };
  async function handle(request: Request, action: "challenge" | "exchange" | "logout") {
    try {
      if (request.method !== "POST") return response(405, { error: "method" });
      if (!matchesBrowserOrigin(request, origin) ||
          request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return response(403, { error: "origin-or-type" });
      if (!request.body) return response(400, { error: "request" });
      const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          request.signal.throwIfAborted(); const part = await reader.read(); request.signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 24576) { await reader.cancel(); return response(413, { error: "request-size" }); }
          chunks.push(part.value);
        }
      } finally { request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return response(400, { error: "request" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return response(400, { error: "request" });
      const keys = Object.keys(body).sort().join();
      if (action === "logout") {
        if (keys !== "") return response(400, { error: "request" });
        return response(200, { ok: true }, [cookie(sessionCookie, "", 0), cookie(challengeCookie, "", 0)]);
      }
      if (action === "challenge") {
        if (keys !== "key" || typeof body.key !== "string") return response(400, { error: "request" });
        const challenge = await sessions.challenge(body.key);
        return response(200, { challenge }, [cookie(challengeCookie, challenge, 60)]);
      }
      if (keys !== "challenge,signature" || typeof body.challenge !== "string" || typeof body.signature !== "string") return response(400, { error: "request" });
      if (body.challenge !== readCookie(request, challengeCookie)) return response(403, { error: "challenge" });
      const token = await sessions.exchange(body.challenge, body.signature);
      if (!token) return response(403, { error: "proof" }, [cookie(challengeCookie, "", 0)]);
      return response(200, { ok: true }, [cookie(sessionCookie, token, 300), cookie(challengeCookie, "", 0)]);
    } catch { return response(503, { error: "session-unavailable" }); }
  }
  return Object.freeze({
    challenge: (request: Request) => handle(request, "challenge"),
    exchange: (request: Request) => handle(request, "exchange"),
    logout: (request: Request) => handle(request, "logout"),
    async authenticate(request: Request) {
      const token = readSeaSessionCookie(request);
      return token ? sessions.authenticate(token) : null;
    },
  });
}
