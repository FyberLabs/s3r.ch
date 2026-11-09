/** Public feed fetch contract shared with browser-safe parsers. */
import { assertPublicHttpUrl } from "./url-guard";

export const PUBLIC_USER_AGENT = "s3r.ch-gun-feed/0.1 (Fyber Labs)";
export const PUBLIC_FETCH_MS = 15_000;

/** Fetching runs on the server; browser consumers may import the constants. */
export async function fetchPublic(url: string | URL, init?: { accept?: string }): Promise<Response> {
  const target = assertPublicHttpUrl(typeof url === "string" ? url : url.href);
  if (typeof window === "undefined") {
    const { fetchPublicOnServer } = await import("./public-fetch-server");
    return fetchPublicOnServer(target, init);
  }
  throw new Error("Public feed fetching requires the server.");
}
