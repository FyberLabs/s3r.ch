import { parseIngestRequest } from "@/lib/browser-pull";
import { normalizeRss3Activities } from "@/lib/normalize";
import { fetchPublic } from "@/lib/public-fetch";
import { parseRssAtom } from "@/lib/rss-atom";
import { fetchAccountActivities, GI_BASE, isRss3Account } from "@/lib/rss3";
import { pullAllowedSource } from "@/lib/seed";
import { assertPublicHttpUrl } from "@/lib/url-guard";
import type { SourcePull } from "@/lib/feed-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 1_000_000;

/**
 * Fetch + normalize only. Does not write the public Gun seed.
 * The client admits returned items onto Mine (GunFeedNode v: 1) and
 * HAM-merges. Explicit share-into-mesh is a separate client put.
 * Same-origin CORS proxy — direct browser-to-source still fails.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }

  const parsed = parseIngestRequest(body);
  if (parsed.kind === "invalid") {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  if (parsed.kind === "rssUrl") {
    return ingestRss(parsed.rssUrl);
  }
  if (parsed.kind === "rss3Account") {
    return ingestRss3Account(parsed.rss3Account);
  }
  return ingestAllowedSource(parsed.allowedSource);
}

async function ingestAllowedSource(kind: Parameters<typeof pullAllowedSource>[0]) {
  try {
    const pulled = await pullAllowedSource(kind);
    return sourcePullResponse(pulled);
  } catch (error) {
    return Response.json(
      {
        items: [],
        source: kind,
        error: error instanceof Error ? error.message : "Allowed source pull failed.",
      },
      { status: 502 },
    );
  }
}

function sourcePullResponse(pulled: SourcePull) {
  const error =
    pulled.items.length === 0
      ? pulled.error || "Source contained no entries."
      : pulled.error;
  return Response.json(
    {
      items: pulled.items,
      sourcesOk: pulled.sourcesOk,
      sourcesTried: pulled.sourcesTried,
      error,
    },
    { status: pulled.sourcesOk === 0 ? 502 : 200 },
  );
}

async function ingestRss(rawUrl: string) {
  let url: URL;
  try {
    url = assertPublicHttpUrl(rawUrl);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid URL." },
      { status: 400 },
    );
  }

  try {
    const response = await fetchPublic(url, {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    });
    if (!response.ok) {
      return Response.json(
        { items: [], error: `Feed HTTP ${response.status}` },
        { status: 502 },
      );
    }
    const xml = await readLimited(response);
    const parsed = parseRssAtom(xml, url.toString());
    return Response.json({
      items: parsed.items,
      source: parsed.source,
      error: parsed.items.length === 0 ? "Feed contained no entries." : null,
    });
  } catch (error) {
    return Response.json(
      {
        items: [],
        error: error instanceof Error ? error.message : "Feed fetch failed.",
      },
      { status: 502 },
    );
  }
}

async function ingestRss3Account(account: string) {
  if (!isRss3Account(account)) {
    return Response.json({ error: "That does not look like an RSS3 account." }, { status: 400 });
  }

  const pulled = await fetchAccountActivities(account);
  const items = normalizeRss3Activities(
    pulled.activities,
    `rss3:gi:${GI_BASE}/decentralized/${account}`,
  );
  return Response.json(
    {
      items,
      source: "rss3",
      error: pulled.error,
    },
    { status: pulled.sourcesOk === 0 ? 502 : 200 },
  );
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      throw new Error("Feed is larger than 1MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
