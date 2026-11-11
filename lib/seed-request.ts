import { authorizeSeed } from "@/lib/auth";
import { combinePulls, pullAllowedSource } from "./seed";
import { applySourcePull, setSeedMeta } from "./gun-server";
import type { SeedReport } from "./feed-types";

export async function handleSeed(request: Request) {
  if (!authorizeSeed(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const report = await seedPublicGraph();
    const empty = report.sourcesOk === 0 && report.written === 0;
    return Response.json(
      {
        seededAt: report.seededAt,
        sourcesOk: report.sourcesOk,
        sourcesTried: report.sourcesTried,
        written: report.written,
        error: report.error,
      },
      { status: empty && report.error ? 503 : 200 },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Seed failed.",
        written: 0,
      },
      { status: 500 },
    );
  }
}

let activeSeed: Promise<SeedReport> | undefined;

/** Coalesce overlapping requests; an older fetch cannot overwrite newer windows. */
export function seedPublicGraph(): Promise<SeedReport> {
  if (!activeSeed) activeSeed = runSeedPull().finally(() => { activeSeed = undefined; });
  return activeSeed;
}

async function runSeedPull(): Promise<SeedReport> {
  const pulled = combinePulls(
    await Promise.all([
      pullAllowedSource("farcaster"),
      pullAllowedSource("atproto"),
      pullAllowedSource("rss"),
      pullAllowedSource("activitypub"),
      pullAllowedSource("nostr"),
      pullAllowedSource("rss3-gi"),
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

  const written = applySourcePull(pulled, seededAt);

  return {
    items: pulled.items,
    seededAt,
    sourcesOk: pulled.sourcesOk,
    sourcesTried: pulled.sourcesTried,
    written,
    error: null,
  };
}

