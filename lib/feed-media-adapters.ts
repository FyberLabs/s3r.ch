import { FEED_MEDIA_MAX, mediaKindForUrl, parseFeedMedia, type FeedMedia } from "./feed-media";
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value.slice(0, FEED_MEDIA_MAX) : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";

export function activityPubMedia(value: unknown): FeedMedia[] {
  const object = row(value);
  const attachments = Array.isArray(object.attachment) ? list(object.attachment) : [object.attachment];
  return parseFeedMedia(attachments.map(value => {
    const item = row(value);
    const candidate = Array.isArray(item.url) ? item.url[0] : item.url;
    const url = typeof candidate === "string" ? candidate : row(candidate).href;
    return { kind: mediaKindForUrl(str(url), str(item.mediaType)), url, alt: item.name,
      playlist: /mpegurl/i.test(str(item.mediaType)), width: item.width, height: item.height, duration: item.duration,
      sensitive: object.sensitive, warning: object.sensitive === true ? object.summary : undefined };
  }));
}

export function farcasterMedia(value: unknown): FeedMedia[] {
  return parseFeedMedia(list(value).map(value => {
    const item = row(value), cast = row(item.castId);
    if (typeof cast.hash === "string" && /^(0x)?[a-f0-9]{40}$/i.test(cast.hash)) {
      const hash = cast.hash.startsWith("0x") ? cast.hash : `0x${cast.hash}`;
      return { kind: "quote", url: `https://farcaster.xyz/~/conversations/${hash}` };
    }
    return { kind: mediaKindForUrl(str(item.url)), url: item.url };
  }));
}

export function nostrMedia(value: unknown): FeedMedia[] {
  const result: unknown[] = [];
  // Bound tags and each imeta record before parsing untrusted strings.
  for (const tag of (Array.isArray(value) ? value.slice(0, 128) : [])) {
    if (!Array.isArray(tag)) continue;
    if (tag[0] === "imeta") {
      const fields: Record<string, string> = {};
      for (const field of tag.slice(1, 17)) {
        if (typeof field !== "string" || field.length > 4096) continue;
        const split = field.indexOf(" ");
        if (split > 0) fields[field.slice(0, split)] = field.slice(split + 1);
      }
      const dimensions = /^(\d{1,5})x(\d{1,5})$/.exec(fields.dim ?? "");
      result.push({ kind: mediaKindForUrl(fields.url ?? "", fields.m), url: fields.url,
        playlist: /mpegurl/i.test(fields.m ?? ""), alt: fields.alt, width: dimensions ? Number(dimensions[1]) : undefined,
        height: dimensions ? Number(dimensions[2]) : undefined });
    } else if (["url", "image"].includes(tag[0]) && typeof tag[1] === "string") {
      result.push({ kind: tag[0] === "image" ? "image" : mediaKindForUrl(tag[1]), url: tag[1] });
    } else if (tag[0] === "q" && typeof tag[1] === "string" && /^[a-f0-9]{64}$/i.test(tag[1])) {
      result.push({ kind: "quote", url: `https://njump.me/${tag[1].toLowerCase()}` });
    }
    if (result.length >= FEED_MEDIA_MAX) break;
  }
  const warningTag = (Array.isArray(value) ? value.slice(0, 128) : []).find(tag => Array.isArray(tag) && tag[0] === "content-warning");
  const warning = warningTag ? (str(warningTag[1]) || "Sensitive media").slice(0, 256) : "";
  return parseFeedMedia(result.map(value => warning ? {...row(value), sensitive:true, warning} : value));
}

export function atprotoMedia(value: unknown, labels?: unknown): FeedMedia[] {
  const result: unknown[] = [];
  function visit(value: unknown, depth: number) {
    if (depth > 2 || result.length >= FEED_MEDIA_MAX) return;
    const embed = row(value), type = str(embed.$type);
    if (type === "app.bsky.embed.images#view") {
      for (const value of list(embed.images)) {
        const image = row(value), size = row(image.aspectRatio);
        result.push({kind: "image", url: image.fullsize, thumbnail: image.thumb, alt: image.alt,
          width: size.width, height: size.height});
      }
    } else if (type === "app.bsky.embed.video#view") {
      const size = row(embed.aspectRatio);
      result.push({kind: "video", playlist:true, url: embed.playlist, thumbnail: embed.thumbnail, alt: embed.alt,
        width: size.width, height: size.height});
    } else if (type === "app.bsky.embed.external#view") {
      const external = row(embed.external);
      result.push({kind: "link", url: external.uri, title: external.title,
        text: external.description, thumbnail: external.thumb});
    } else if (type === "app.bsky.embed.record#view") {
      const record = row(embed.record), author = row(record.author), content = row(record.value);
      const uri = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(str(record.uri));
      if (uri && uri[1].isWellFormed() && uri[2].isWellFormed()) result.push({kind: "quote", url: `https://bsky.app/profile/${encodeURIComponent(uri[1])}/post/${encodeURIComponent(uri[2])}`,
        author: author.handle, text: content.text});
    } else if (type === "app.bsky.embed.recordWithMedia#view") {
      visit(embed.media, depth + 1); visit(embed.record, depth + 1);
    }
  }
  visit(value, 0);
  const warning = (Array.isArray(labels) ? labels.slice(0, 32) : [])
    .map(row).filter(label => label.neg !== true && typeof label.val === "string")
    .map(label => str(label.val)).join(", ").slice(0, 256);
  return parseFeedMedia(result.slice(0, FEED_MEDIA_MAX).map(value => warning ? {...row(value), sensitive:true, warning} : value));
}

export function mediaFields(media: FeedMedia[]): {media?: FeedMedia[]} {
  return media.length ? {media} : {};
}
