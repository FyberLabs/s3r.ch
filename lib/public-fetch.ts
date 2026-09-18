/** Shared lab seeder / ingest fetch defaults. */

export const PUBLIC_USER_AGENT = "s3r.ch-gun-feed/0.1 (Fyber Labs)";
/** Per-request budget for parallel public pulls. 8s is tight on App Service egress. */
export const PUBLIC_FETCH_MS = 15_000;

export async function fetchPublic(
  url: string | URL,
  init?: { accept?: string },
): Promise<Response> {
  return fetch(url, {
    headers: {
      accept: init?.accept ?? "application/json",
      "user-agent": PUBLIC_USER_AGENT,
    },
    signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
    redirect: "follow",
    cache: "no-store",
  });
}
