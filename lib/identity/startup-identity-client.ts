import { resolveStartupLinkedIdentity, snapshotStartupLoginBinding,
  type StartupLinkedIdentity, type StartupLoginBinding } from "./startup-linked-login";

/** Server-side read adapter for Auth's configured endpoint. The caller owns the
 * verified OIDC exchange; bearer tokens exist only for this request, never storage.
 */
export function createStartupIdentityClient(input: {
  endpoint: string; expected: StartupLoginBinding; fetch?: typeof fetch;
}) {
  const endpoint = new URL(input.endpoint), expected = snapshotStartupLoginBinding(input.expected);
  if (!expected || endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/auth/startup/identity")) {
    throw Error("Explicit startup identity configuration required");
  }
  const target = endpoint.href, fetcher = input.fetch ?? fetch;
  return Object.freeze({
    async resolve(accessToken: string, verifiedSubject: string,
      existing: Readonly<{ sea_public_key: string; person_id?: string }>, abort?: AbortSignal): Promise<StartupLinkedIdentity | null> {
      if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(accessToken)) return null;
      // Capture the existing account before any network operation.
      const account = { sea_public_key: existing.sea_public_key, person_id: existing.person_id };
      const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(abort ? [abort] : [])]);
      try {
        signal.throwIfAborted();
        const response = await fetcher(target, { method: "GET", redirect: "error", cache: "no-store",
          credentials: "omit", signal, headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
        if (signal.aborted || response.status !== 200 || response.redirected || !response.body ||
            response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
          await response.body?.cancel(); return null;
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 16384) { await reader.cancel(); return null; }
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          return resolveStartupLinkedIdentity(value, expected, verifiedSubject, account);
        } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
      } catch { return null; }
    },
  });
}
