import { createSeaSessionClient } from "./identity/sea-session-client";
import { seaSessionCookieNames } from "./identity/sea-session-http";
import type { SeaPair } from "./identity/sea";
/** A fresh in-memory cookie jar belongs only to this independent SEA bot key.
 * Nothing is imported from a browser or wallet session, and redirects are denied.
 */
export function createBotSession(input: { origin: string; pair: SeaPair; fetch?: typeof fetch }) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Explicit HTTPS bot origin required");
  const names = new Set<string>(seaSessionCookieNames());
  const fetcher = input.fetch ?? fetch, pair = Object.freeze({ ...input.pair }), cookies = new Map<string, string>();
  const scopedFetch: typeof fetch = async (target, init) => {
    if (typeof target !== "string" || !/^\/[A-Za-z0-9/_-]+$/.test(target) || target.startsWith("//")) throw Error("Bot session endpoint differs");
    const headers = new Headers(init?.headers); headers.set("Origin", origin.origin);
    headers.delete("Cookie"); headers.delete("Authorization");
    if (cookies.size) headers.set("Cookie", [...cookies].map(([name, value]) => name + "=" + value).join("; "));
    const response = await fetcher(origin.origin + target, { ...init, headers, redirect: "error", cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(1500), ...(init?.signal ? [init.signal] : [])]) });
    if (response.redirected) { await response.body?.cancel(); throw Error("Bot session redirect refused"); }
    for (const cookie of response.headers.getSetCookie()) {
      const [first, ...attributes] = cookie.split(";"), at = first.indexOf("="), name = first.slice(0, at), value = first.slice(at + 1);
      if (!names.has(name)) continue;
      if (at < 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(name) || !/^[\x21-\x3a\x3c-\x7e]{0,8192}$/.test(value) ||
          attributes.some(a => /^\s*domain=/i.test(a)) || !attributes.some(a => /^\s*secure\s*$/i.test(a)) ||
          !attributes.some(a => /^\s*httponly\s*$/i.test(a)) || !attributes.some(a => /^\s*path=\/\s*$/i.test(a))) throw Error("Invalid bot session cookie");
      if (!value || attributes.some(a => /^\s*max-age=0\s*$/i.test(a))) cookies.delete(name);
      else { if (!cookies.has(name) && cookies.size >= 8) throw Error("Bot session cookie capacity"); cookies.set(name, value); }
    }
    return response;
  };
  const client = createSeaSessionClient({ origin: origin.origin, base: "/api/identity/sea", fetch: scopedFetch });
  return Object.freeze({ fetch: scopedFetch, async signIn() { cookies.clear(); return client.signIn(pair); },
    async close() { try { await client.logout(); } finally { cookies.clear(); } } });
}
