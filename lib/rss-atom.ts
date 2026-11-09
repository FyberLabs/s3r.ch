import type { FeedItem, FeedSource, SourcePull } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";
import { fetchPublicText } from "./public-fetch";

const MAX_ITEMS = 30;
const BODY_MAX = 320;

export type PublicRssFeed = {
  url: string;
  extraTags: string[];
};

/** Live RSS/Atom URLs probed 200 on 2026-09-01. Follow redirects. */
export const PUBLIC_RSS_FEEDS: PublicRssFeed[] = [
  { url: "https://blog.ethereum.org/en/feed.xml", extraTags: ["ethereum", "social"] },
  {
    url: "https://github.com/farcasterxyz/protocol/commits/main.atom",
    extraTags: ["farcaster"],
  },
];

export type ParsedFeed = {
  source: FeedSource;
  items: FeedItem[];
};

export function parseRssAtom(xml: string, feedUrl: string): ParsedFeed {
  const kind: FeedSource = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml)
    ? "atom"
    : "rss";
  const blocks =
    kind === "atom"
      ? matchBlocks(xml, "entry")
      : matchBlocks(xml, "item");

  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const item =
      kind === "atom"
        ? fromAtom(block, feedUrl)
        : fromRss(block, feedUrl);
    if (!item) continue;
    const key = canonicalKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  return { source: kind, items };
}

function fromRss(block: string, feedUrl: string): FeedItem | null {
  const permalink = textTag(block, "link") || "";
  const id = textTag(block, "guid") || permalink;
  if (!id) return null;
  const author =
    textTag(block, "author") ||
    textTag(block, "dc:creator") ||
    hostnameOf(feedUrl);
  return {
    id,
    source: "rss",
    kind: "rss",
    author,
    body: clip(stripTags(textTag(block, "title") || textTag(block, "description") || ""), BODY_MAX),
    ts: parseDate(textTag(block, "pubDate") || textTag(block, "dc:date")),
    permalink,
    tags: normalizeTags(["rss", "user"]),
    provenance: `rss:${feedUrl}`,
  };
}

function fromAtom(block: string, feedUrl: string): FeedItem | null {
  const permalink = attr(block, "link", "href") || textTag(block, "link") || "";
  const id = textTag(block, "id") || permalink;
  if (!id) return null;
  const author =
    textTag(innerTag(block, "author"), "name") ||
    textTag(block, "author") ||
    hostnameOf(feedUrl);
  const body =
    textTag(block, "title") ||
    textTag(block, "summary") ||
    textTag(block, "content") ||
    "";
  return {
    id,
    source: "atom",
    kind: "atom",
    author,
    body: clip(stripTags(body), BODY_MAX),
    ts: parseDate(textTag(block, "updated") || textTag(block, "published")),
    permalink,
    tags: normalizeTags(["atom", "user"]),
    provenance: `atom:${feedUrl}`,
  };
}

function matchBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
  return xml.match(re) ?? [];
}

function textTag(xml: string, tag: string): string {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`,
    "i",
  );
  const match = xml.match(re);
  return decode(match?.[1] ?? match?.[2] ?? "").trim();
}

function innerTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  return xml.match(re)?.[1] ?? "";
}

function attr(xml: string, tag: string, name: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${name}=["']([^"']+)["'][^>]*/?>`, "i");
  return decode(xml.match(re)?.[1] ?? "").trim();
}

function parseDate(value: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&amp;": "&",
};

/** One pass, so `&amp;lt;` stays `&lt;` instead of becoming `<`. */
function decode(value: string): string {
  return value.replace(/&(?:lt|gt|quot|amp|#39);/g, (entity) => NAMED_ENTITIES[entity] ?? entity);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function fetchPublicRss(): Promise<SourcePull> {
  const results = await Promise.allSettled(PUBLIC_RSS_FEEDS.map((feed) => pullRss(feed)));

  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let sourcesOk = 0;
  const failures: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      sourcesOk += 1;
      for (const item of result.value) {
        const key = canonicalKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    } else {
      failures.push(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }

  if (sourcesOk === 0) {
    return {
      items: [],
      sourcesOk: 0,
      sourcesTried: PUBLIC_RSS_FEEDS.length,
      error:
        "RSS/Atom feeds did not return entries. This feed does not invent rows. " +
        (failures[0] ?? "All feed requests failed."),
    };
  }

  return {
    items,
    sourcesOk,
    sourcesTried: PUBLIC_RSS_FEEDS.length,
    error: null,
  };
}

async function pullRss(feed: PublicRssFeed): Promise<FeedItem[]> {
  const { text: xml, url } = await fetchPublicText(feed.url, {
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  });
  const parsed = parseRssAtom(xml, url || feed.url);
  return parsed.items.map((item) => ({
    ...item,
    tags: normalizeTags([
      ...item.tags.filter((tag) => tag !== "user"),
      ...feed.extraTags,
    ]),
  }));
}
