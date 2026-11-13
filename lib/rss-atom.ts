import { mediaFields } from "./feed-media-adapters";
import { mediaKindForUrl, parseFeedMedia } from "./feed-media";
import { collectSourceWindows } from "./source-windows";
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
  const kind: FeedSource = /<feed[\s/>]/i.test(xml) ? "atom" : "rss";
  const root = kind === "atom" ? "feed" : "rss";
  if (!new RegExp(`<${root}\\b[^>]*(?:/>|>[\\s\\S]*</${root}\\s*>)`, "i").test(xml)) {
    throw new Error("Incomplete or unrecognized RSS/Atom document");
  }
  const blocks =
    kind === "atom"
      ? matchBlocks(xml, "entry")
      : matchBlocks(xml, "item");

  const tag = kind === "atom" ? "entry" : "item";
  if ((xml.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length !== blocks.length) {
    throw new Error("Incomplete RSS/Atom entries");
  }
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
    ...mediaFields(enclosureMedia(block, feedUrl)),
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
    ...mediaFields(enclosureMedia(block, feedUrl)),
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
  return collectSourceWindows(
    PUBLIC_RSS_FEEDS.map(feed => ({ key: `rss:${feed.url}`, pull: () => pullRss(feed) })),
    ["rss", "atom"],
    "RSS/Atom feeds did not return entries.",
  );
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

function enclosureMedia(block: string, feedUrl: string) {
  const media: unknown[] = [];
  for (const match of block.matchAll(/<(enclosure|media:content|link)\b[^>]*>/gi)) {
    const tag = match[1], element = match[0];
    if (tag.toLowerCase() === "link" && attr(element, tag, "rel") !== "enclosure") continue;
    const raw = attr(element, tag, tag.toLowerCase() === "link" ? "href" : "url");
    if (!raw) continue;
    try {
      const url = new URL(raw, feedUrl).href;
      media.push({ kind: mediaKindForUrl(url, attr(element, tag, "type")), url,
        width: Number(attr(element, tag, "width")), height: Number(attr(element, tag, "height")),
        duration: Number(attr(element, tag, "duration")) });
    } catch { continue; }
    if (media.length === 8) break;
  }
  return parseFeedMedia(media);
}
