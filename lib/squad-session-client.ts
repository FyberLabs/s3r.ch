import { decodeJwt, decodeProtectedHeader } from "jose";
import { signForumRecord } from "./forum-sign";
import type { SeaPair } from "./identity/sea";
import { squadView, isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";

/** Explicit same-origin endpoints only. Session cookies remain HttpOnly; this
 * client never reads or persists bearer tokens. Callers must invalidate their
 * authority source on logout/key changes and renew via a fresh sign-in. */
export function createSquadSessionClient(input: { base: string; origin: string; squad: LiveSquadSpec; fetch?: typeof fetch; clock?: () => number }) {
  const view = squadView(input.squad), origin = new URL(input.origin);
  if (!view.live || origin.origin !== input.origin || origin.protocol !== "https:" || !/^\/[A-Za-z0-9/_-]+$/.test(input.base) || input.base.startsWith("//")) throw Error("Explicit HTTPS session scope required");
  const fetcher = input.fetch ?? fetch, base = input.base.replace(/\/$/, ""), clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  let busy = false;
  async function post(action: string, body: object, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const response = await fetcher(`${base}/${action}`, { method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !response.body) {
      await response.body?.cancel(); throw Error("Session unavailable");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); }; signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted(); const part = await reader.read(); signal?.throwIfAborted(); if (part.done) break;
        size += part.value.byteLength; if (size > 8192) { await reader.cancel(); throw Error("Session response too large"); } chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  }
  return Object.freeze({
    async signIn(pair: SeaPair, signal?: AbortSignal): Promise<boolean> {
      if (busy) return false;
      busy = true;
      try {
        // Snapshot the selected key before network awaits; a later UI selection
        // must not change which key signs this exchange.
        const signingPair = { ...pair };
        if (isPublicSquadPrincipal(signingPair.pub)) return false;
        const reply = await post("challenge", { key: signingPair.pub }, signal);
        if (!reply || Object.keys(reply).join() !== "challenge" || typeof reply.challenge !== "string" || reply.challenge.length > 4096) return false;
        const header = decodeProtectedHeader(reply.challenge), claims = decodeJwt(reply.challenge), now = clock();
        // Decoding is a signing-intent check, not server-token verification.
        // The server verifies its MAC, single-use cookie binding and SEA proof.
        if (Object.keys(header).sort().join() !== "alg,typ" || Object.keys(claims).sort().join() !== "aud,exp,iat,iss,jti,sub" || (typeof header.typ !== "string" || !/^s3rch-identity-challenge-v1(?::[0-9a-f]{64})?$/.test(header.typ)) || header.alg !== "HS256" || claims.iss !== origin.origin || claims.aud !== origin.origin ||
            claims.sub !== signingPair.pub || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
            claims.iat! > now || claims.exp! <= now || claims.exp! - claims.iat! !== 60 || typeof claims.jti !== "string" || !/^[0-9a-f]{64}$/.test(claims.jti)) return false;
        signal?.throwIfAborted();
        const signature = await signForumRecord(reply.challenge, signingPair); if (!signature) return false;
        signal?.throwIfAborted();
        const result = await post("exchange", { challenge: reply.challenge, signature }, signal);
        return result?.ok === true && Object.keys(result).join() === "ok";
      } catch { return false; } finally { busy = false; }
    },
    async logout(signal?: AbortSignal): Promise<boolean> {
      if (busy) return false;
      busy = true;
      try { const result = await post("logout", {}, signal); return result?.ok === true && Object.keys(result).join() === "ok"; }
      catch { return false; } finally { busy = false; }
    },
  });
}
