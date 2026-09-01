import type { FeedItem, SeedReport, SourcePull } from "./feed-types";
import { fetchPublicAtproto } from "./atproto";
import { fetchPublicCasts } from "./farcaster";
import { putItems, setSeedMeta } from "./gun-server";
import { canonicalKey } from "./merge";
import { normalizeRss3Activities } from "./normalize";
import { fetchPublicRss } from "./rss-atom";
import { fetchPublicActivities, GI_BASE } from "./rss3";

export async function seedPublicGraph(): Promise<SeedReport> {
  const pulled = combinePulls(
    await Promise.all([
      fetchPublicCasts(),
      fetchPublicAtproto(),
      fetchPublicRss(),
      fetchOptionalGi(),
    ]),
  );
  const seededAt = new Date().toISOString();

  if (pulled.sourcesOk === 0) {
    setSeedMeta({
      seededAt,
      sourcesOk: 0,
      sourcesTried: pulled.sourcesTried,
      error: pulled.error,
    });
    return {
      items: [],
      seededAt,
      sourcesOk: 0,
      sourcesTried: pulled.sourcesTried,
      written: 0,
      error: pulled.error,
    };
  }

  const written = putItems(pulled.items);
  setSeedMeta({
    seededAt,
    sourcesOk: pulled.sourcesOk,
    sourcesTried: pulled.sourcesTried,
    error: null,
  });

  return {
    items: pulled.items,
    seededAt,
    sourcesOk: pulled.sourcesOk,
    sourcesTried: pulled.sourcesTried,
    written,
    error: null,
  };
}

/** GI is optional. DNS/HTTP failure does not empty other sources. */
export async function fetchOptionalGi(): Promise<SourcePull> {
  try {
    const pulled = await fetchPublicActivities();
    const items = normalizeRss3Activities(
      pulled.activities,
      `rss3:gi:${GI_BASE}/decentralized`,
    );
    return {
      items,
      sourcesOk: pulled.sourcesOk,
      sourcesTried: pulled.sourcesTried,
      error: pulled.error,
    };
  } catch (error) {
    return {
      items: [],
      sourcesOk: 0,
      sourcesTried: 1,
      error:
        error instanceof Error
          ? error.message
          : "RSS3 Global Indexer request failed.",
    };
  }
}

export function combinePulls(pulls: SourcePull[]): SourcePull {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let sourcesOk = 0;
  let sourcesTried = 0;
  const failures: string[] = [];

  for (const pull of pulls) {
    sourcesOk += pull.sourcesOk;
    sourcesTried += pull.sourcesTried;
    if (pull.error) failures.push(pull.error);
    for (const item of pull.items) {
      const key = canonicalKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  return {
    items,
    sourcesOk,
    sourcesTried,
    error:
      sourcesOk === 0
        ? failures[0] ??
          "No public source returned items. This feed does not invent rows."
        : null,
  };
}
