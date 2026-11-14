import { decodeJwt, decodeProtectedHeader } from "jose";
import { parseEip55, parsePrincipalId } from "sociacl-ids";
import { isPublicSquadPrincipal } from "../squad-view";
import { readBoundedIdentityJson } from "./bounded-json";

/** Revisions must increase on every wallet/account/chain or session change,
 * including away-and-back changes. The caller cancels on those events too. */
export type LinkedWalletSelection = Readonly<{
  address: string; chainId: string; walletRevision: number; sessionRevision: number;
}>;
const exact = (v: unknown, keys: string): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys;
const revision = (v: number) => Number.isSafeInteger(v) && v >= 0;

/** Browser controller only: no enrollment, bearer storage, or capability flag.
 * A successful challenge is required before asking the wallet to sign. */
export function createLinkedWalletClient(input: {
  origin: string; current: () => LinkedWalletSelection | null;
  signMessage: (message: string, selected: LinkedWalletSelection) => Promise<string>;
  fetch?: typeof fetch; clock?: () => number;
}) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Explicit HTTPS origin required");
  const fetcher = input.fetch ?? fetch, clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const base = "/api/identity/sea";
  let active: AbortController | undefined;
  return Object.freeze({
    cancel() { active?.abort(); },
    async signIn(signal?: AbortSignal): Promise<boolean> {
      if (active) return false;
      const controller = new AbortController(); active = controller;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(abort, 30_000);
      try {
        const value = input.current();
        if (!value) return false;
        const selected = Object.freeze({ ...value });
        if (!parseEip55(selected.address).ok || !/^[1-9][0-9]{0,15}$/.test(selected.chainId) ||
            !Number.isSafeInteger(Number(selected.chainId)) || !revision(selected.walletRevision) || !revision(selected.sessionRevision)) return false;
        const check = () => {
          controller.signal.throwIfAborted();
          const current = input.current();
          if (!current || current.address !== selected.address || current.chainId !== selected.chainId ||
              current.walletRevision !== selected.walletRevision || current.sessionRevision !== selected.sessionRevision) throw Error("Selection changed");
        };
        // Race even uncooperative injected transports/signers; the underlying
        // flow still checks cancellation before any subsequent side effect.
        const bounded = async <T>(operation: Promise<T>): Promise<T> => {
          let stop: () => void = () => {};
          const cancelled = new Promise<never>((_, reject) => { stop = () => reject(Error("Cancelled")); controller.signal.addEventListener("abort", stop, { once: true }); });
          try {
            const result = Promise.race([operation, cancelled]);
            if (controller.signal.aborted) stop();
            return await result;
          }
          finally { controller.signal.removeEventListener("abort", stop); }
        };
        const post = async (action: string, body: object) => {
          check();
          const response = await bounded(fetcher(`${base}/${action}`, { method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) }));
          check();
          if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            void response.body?.cancel().catch(() => {}); throw Error("Session unavailable");
          }
          const result = await bounded(readBoundedIdentityJson(response, 8192, controller.signal)); check(); return result;
        };
        const reply = await post("linked-challenge", { credential: { kind: "wallet", address: selected.address } });
        if (!exact(reply, "challenge") || typeof reply.challenge !== "string" || reply.challenge.length > 4096) return false;
        const token = reply.challenge, header = decodeProtectedHeader(token), claims = decodeJwt(token), now = clock();
        // Signing-intent decoding only; issuer MAC/current authority/replay are
        // verified by the server. Never treat this payload as an identity source.
        if (!exact(header, "alg,typ") || header.alg !== "HS256" || typeof header.typ !== "string" || !/^s3rch-linked-challenge-v1(?::[0-9a-f]{64})?$/.test(header.typ) ||
            !exact(claims, "aud,credential,exp,iat,iss,jti,linkId,sub") || claims.iss !== origin.origin || claims.aud !== origin.origin ||
            typeof claims.sub !== "string" || !parsePrincipalId(claims.sub).ok || isPublicSquadPrincipal(claims.sub) ||
            !exact(claims.credential, "address,kind") || claims.credential.kind !== "wallet" || claims.credential.address !== selected.address ||
            typeof claims.linkId !== "string" || !/^[0-9a-f]{64}$/.test(claims.linkId) || typeof claims.jti !== "string" || !/^[0-9a-f]{64}$/.test(claims.jti) ||
            !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat! < 0 || claims.iat! > now || claims.exp! <= now || claims.exp! - claims.iat! !== 60) return false;
        const digest = new Uint8Array(await bounded(crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))); check();
        const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        const message = `${origin.host} wants you to sign in with your Ethereum account:\n${selected.address}\n\nSociACL link: ${hash}\n\nURI: ${origin.origin}${base}/linked-exchange\nVersion: 1\nChain ID: ${selected.chainId}\nNonce: ${claims.jti}\nIssued At: ${new Date(claims.iat! * 1000).toISOString().replace(".000Z", "Z")}\nExpiration Time: ${new Date(claims.exp! * 1000).toISOString().replace(".000Z", "Z")}`;
        check(); if (claims.exp! <= clock()) return false;
        const signature = await bounded(input.signMessage(message, selected));
        check(); if (claims.exp! <= clock() || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
        const result = await post("linked-exchange", { challenge: token, proof: { message, signature } });
        check(); return exact(result, "ok") && result.ok === true;
      } catch { return false; }
      finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); controller.abort(); if (active === controller) active = undefined; }
    },
  });
}
