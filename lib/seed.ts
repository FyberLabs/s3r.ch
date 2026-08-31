import type { SeedReport } from "./feed-types";
import { putItems, setSeedMeta } from "./gun-server";
import { normalizeRss3Activities } from "./normalize";
import { fetchPublicActivities, GI_BASE } from "./rss3";

export async function seedPublicGraph(): Promise<SeedReport> {
  const pulled = await fetchPublicActivities();
  const provenance = `rss3:gi:${GI_BASE}/decentralized`;
  const items = normalizeRss3Activities(pulled.activities, provenance);
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

  const written = putItems(items);
  setSeedMeta({
    seededAt,
    sourcesOk: pulled.sourcesOk,
    sourcesTried: pulled.sourcesTried,
    error: null,
  });

  return {
    items,
    seededAt,
    sourcesOk: pulled.sourcesOk,
    sourcesTried: pulled.sourcesTried,
    written,
    error: null,
  };
}
