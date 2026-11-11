import type { AllowedSourceClass } from "./browser-pull";
import type { FeedItem, SourcePull } from "./feed-types";
import { fetchPublicActivityPub } from "./activitypub";
import { fetchPublicAtproto } from "./atproto";
import { fetchPublicCasts } from "./farcaster";
import { canonicalKey } from "./merge";
import { fetchPublicNostr } from "./nostr";
import { normalizeRss3Activities } from "./normalize";
import { fetchPublicRss } from "./rss-atom";
import { fetchPublicActivities, GI_BASE } from "./rss3";

/** Same documented classes the lab seeder pulls. Empty/failed write nothing. */
export async function pullAllowedSource(
  kind: AllowedSourceClass,
): Promise<SourcePull> {
  switch (kind) {
    case "farcaster":
      return fetchPublicCasts();
    case "atproto":
      return fetchPublicAtproto();
    case "rss":
      return fetchPublicRss();
    case "activitypub":
      return fetchPublicActivityPub();
    case "nostr":
      return fetchPublicNostr();
    case "rss3-gi":
      return fetchOptionalGi();
  }
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
      windows: pulled.windows?.map(window => ({ key: `rss3:${window.key}`,
        items: normalizeRss3Activities(window.activities, `rss3:gi:${GI_BASE}/decentralized`) })),
      completeSources: pulled.sourcesOk === pulled.sourcesTried ? ["rss3"] : [],
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
    windows: pulls.flatMap(pull => pull.windows ?? []),
    completeSources: [...new Set(pulls.flatMap(pull => pull.completeSources ?? []))],
    sourcesOk,
    sourcesTried,
    error:
      sourcesOk === 0
        ? failures[0] ??
          "No public source returned items. This feed does not invent rows."
        : null,
  };
}
