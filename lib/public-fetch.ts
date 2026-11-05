/** Shared lab seeder / ingest fetch defaults. */

import { lookup } from "node:dns/promises";
import { assertPublicHttpUrl, isBlockedIpAddress, isIpLiteralHost } from "./url-guard";

export const PUBLIC_USER_AGENT = "s3r.ch-gun-feed/0.1 (Fyber Labs)";
/** Per-request budget for parallel public pulls. 8s is tight on App Service egress. */
export const PUBLIC_FETCH_MS = 15_000;
const MAX_REDIRECTS = 20;

/**
 * GET a public http(s) URL. Schemes other than http(s), and hosts that are
 * loopback, private, link-local, CGNAT, multicast, or cloud metadata, are
 * rejected. Redirects are followed only when the next hop passes the same
 * check. Names are also rejected when DNS returns a blocked address.
 */
export async function fetchPublic(
  url: string | URL,
  init?: { accept?: string },
): Promise<Response> {
  const signal = AbortSignal.timeout(PUBLIC_FETCH_MS);
  let current = assertPublicHttpUrl(typeof url === "string" ? url : url.href);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertResolvedPublicHost(current);
    // codeql[js/request-forgery] -- http(s) only; private and metadata hosts are blocked, including redirects. A host allowlist would reject caller-supplied public feeds.
    const response = await fetch(current, {
      headers: {
        accept: init?.accept ?? "application/json",
        "user-agent": PUBLIC_USER_AGENT,
      },
      signal,
      redirect: "manual",
      cache: "no-store",
    });
    const location = response.headers.get("location");
    if (!isRedirectStatus(response.status) || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop === MAX_REDIRECTS) throw new Error("Too many redirects.");
    current = assertPublicHttpUrl(new URL(location, current).href);
  }
  throw new Error("Too many redirects.");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function assertResolvedPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteralHost(host)) return;
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    // fetch reports the DNS failure the same way it did before this check.
    return;
  }
  if (records.length === 0 || records.some((record) => isBlockedIpAddress(record.address))) {
    throw new Error("That host is not allowed.");
  }
}
