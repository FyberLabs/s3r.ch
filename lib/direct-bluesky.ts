import { executePullRelay, seedUrlsForClass } from "./pull-relay";
import { PUBLIC_FETCH_MS, readPublicFeedBody } from "./public-fetch";

// Only the two fixed public AppView requests can use this browser transport.
export async function pullPublicBluesky() {
  const endpoints = new Set(seedUrlsForClass("atproto"));
  const result = await executePullRelay({ allowedSource: "atproto" }, {
    async fetchText(url) {
      if (!endpoints.has(url)) throw new Error("Unknown Bluesky feed.");
      const response = await fetch(url, {
        credentials: "omit", redirect: "error", mode: "cors", referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Bluesky feed unavailable.");
      }
      const { text } = await readPublicFeedBody(response);
      const data = JSON.parse(text);
      if (!Array.isArray(data?.feed)) throw new Error("Invalid Bluesky feed.");
      return { url, status: response.status, body: text };
    },
  });
  return result.kind === "result" && result.sourcesOk > 0
    ? { items: result.items, error: result.error }
    : null;
}
