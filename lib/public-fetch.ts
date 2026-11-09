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

export const PUBLIC_FEED_BYTES = 1_000_000;
// A full configured seed can start 18 HTTP pulls, including username lookups.
export const PUBLIC_FEED_CONCURRENCY = 20;
let activePulls = 0;

type FeedOptions = { accept?: string; httpLabel?: string };

export async function fetchPublicText(url: string | URL, options: FeedOptions = {}) {
  if (activePulls >= PUBLIC_FEED_CONCURRENCY) {
    throw new Error("Too many concurrent public feed pulls.");
  }
  activePulls++;
  try {
    const response = await fetchPublic(url, options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${options.httpLabel ?? url} HTTP ${response.status}`);
    }
    return await readPublicFeedBody(response);
  } finally {
    activePulls--;
  }
}

export async function readPublicFeedBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", url: response.url };

  // A single capped buffer also bounds bookkeeping for tiny or empty chunks.
  try {
    const bytes = new Uint8Array(PUBLIC_FEED_BYTES);
    let used = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.length - used) throw new Error("Feed is larger than 1MB.");
      bytes.set(value, used);
      used += value.byteLength;
    }
    return { text: new TextDecoder().decode(bytes.subarray(0, used)), url: response.url };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchPublicJson(url: string | URL, options?: FeedOptions): Promise<unknown> {
  // The bounded body is already drained and unlocked even if parsing fails.
  const { text } = await fetchPublicText(url, options);
  return JSON.parse(text);
}
