import type { FeedItem, FeedSource } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";

const MAX_ITEMS = 30;
const BODY_MAX = 320;

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

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
