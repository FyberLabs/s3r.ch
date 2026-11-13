import { assertPublicHttpUrl } from "./url-guard";
export type FeedMedia = {
  kind: "image"|"video"|"audio"|"link"|"quote";
  url: string; alt?: string; title?: string; text?: string; author?: string; thumbnail?: string;
  width?: number; height?: number; duration?: number; sensitive?: boolean; warning?: string;
};
export const FEED_MEDIA_MAX=8, FEED_MEDIA_BYTES=16384;
export function publicMediaUrl(value: unknown): string|null {
  if(typeof value!=="string" || value.length>2048)return null;
  try {const url=assertPublicHttpUrl(value);if(url.username || url.password)return null;url.hash="";return url.href.length<=2048 ? url.href : null;}catch{return null;}
}
/** Additive public metadata only. Private wraps/keys must never enter this shape. */
export function parseFeedMedia(value: unknown): FeedMedia[] {
  if(typeof value==="string") {
    if(value.length>FEED_MEDIA_BYTES)return [];
    try {value=JSON.parse(value);}catch{return [];}
  }
  if(!Array.isArray(value) || value.length>FEED_MEDIA_MAX)return [];
  const result:FeedMedia[]=[];
  for(const raw of value) {
    if(!raw || typeof raw!=="object" || Array.isArray(raw))continue;
    const row=raw as Record<string,unknown>,url=publicMediaUrl(row.url);
    if(!url || !["image","video","audio","link","quote"].includes(row.kind as string))continue;
    const media:FeedMedia={kind:row.kind as FeedMedia['kind'],url};
    for(const [key,max] of [["alt",1024],["title",256],["text",4000],["author",256],["warning",256]] as const)
      if(typeof row[key]==="string" && (row[key] as string).length<=max)media[key]=row[key] as string;
    const thumbnail=publicMediaUrl(row.thumbnail);if(thumbnail)media.thumbnail=thumbnail;
    for(const key of ["width","height","duration"] as const)
      if(typeof row[key]==="number" && Number.isFinite(row[key]) && (row[key] as number)>0 &&
          (row[key] as number)<=(key==="duration"?86400:16384))media[key]=row[key] as number;
    if(row.sensitive===true || media.warning)media.sensitive=true;
    result.push(media);
  }
  return new TextEncoder().encode(JSON.stringify(result)).length<=FEED_MEDIA_BYTES ? result : [];
}
export function mediaKindForUrl(url: string, mime=""): FeedMedia['kind'] {
  const type=mime.split(";")[0].toLowerCase();
  if(type.startsWith("image/"))return "image";
  if(type.startsWith("audio/"))return "audio";
  if(type.startsWith("video/") || /mpegurl/.test(type))return "video";
  let path="";try{path=new URL(url).pathname.toLowerCase();}catch{return "link";}
  if(/\.(png|jpe?g|gif|webp|avif)$/.test(path))return "image";
  if(/\.(mp3|m4a|wav|oga|ogg)$/.test(path))return "audio";
  if(/\.(mp4|webm|ogv|m3u8)$/.test(path))return "video";
  return "link";
}
