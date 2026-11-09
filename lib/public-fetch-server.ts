/** Node transport, loaded only by the server branch of public-fetch. */
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";
import { PUBLIC_FETCH_MS, PUBLIC_USER_AGENT } from "./public-fetch";
import { assertPublicHttpUrl, isBlockedIpAddress, isIpLiteralHost } from "./url-guard";

type Resolver = (host: string) => Promise<LookupAddress[]>;

/**
 * Validate inside the socket's lookup, rather than resolving once to check and
 * again to connect. The connector retains the original hostname for Host/SNI
 * and normal certificate verification. No fallback lookup is permitted.
 */
export function createPublicLookup(
  signal: AbortSignal,
  resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
): LookupFunction {
  return (host, options, callback) => {
    let settled = false;
    const finish = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[] = []) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) return callback(error, "");
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Request aborted", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return resolve(host);
    }).then((records) => {
      if (signal.aborted) return abort();
      if (!records.length || records.some((row) =>
        !isIpLiteralHost(row.address) || isBlockedIpAddress(row.address)
        || (row.family !== 4 && row.family !== 6))) {
        throw new Error("That host is not allowed.");
      }
      const family = options.family;
      const selected = family === 4 || family === 6
        ? records.filter((row) => row.family === family) : records;
      if (!selected.length) throw new Error("No public address for the requested family.");
      finish(null, selected);
    }).catch((error: NodeJS.ErrnoException) => finish(error));
  };
}

export async function fetchPublicOnServer(url: URL, init?: { accept?: string }): Promise<Response> {
  const signal = AbortSignal.timeout(PUBLIC_FETCH_MS);
  const dispatcher = new Agent({ connect: { lookup: createPublicLookup(signal) } });
  let current = assertPublicHttpUrl(url.href);
  try {
    for (let hop = 0; hop <= 20; hop += 1) {
      signal.throwIfAborted();
      // URL checks cover literals and redirects. This dispatcher validates
      // every DNS answer inside the socket lookup, preserving Host and TLS SNI.
      // codeql[js/request-forgery] -- Validated socket lookup; see public-fetch-server.test.ts.
      const response = await fetch(current, {
        headers: { accept: init?.accept ?? "application/json", "user-agent": PUBLIC_USER_AGENT },
        signal, redirect: "manual", cache: "no-store", dispatcher,
      } as RequestInit & { dispatcher: Agent });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      await response.body?.cancel().catch(() => undefined);
      if (hop === 20) throw new Error("Too many redirects.");
      current = assertPublicHttpUrl(new URL(location, current).href);
    }
    throw new Error("Too many redirects.");
  } finally {
    // Graceful close waits for the returned response body; do not destroy it at
    // headers, or leave a per-request pool alive after that body completes.
    void dispatcher.close().catch(() => dispatcher.destroy().catch(() => undefined));
  }
}
