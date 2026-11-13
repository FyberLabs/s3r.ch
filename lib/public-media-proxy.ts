import {createMediaBudget} from "./public-media-admission";
import { fetchPublic } from "./public-fetch";
import { publicMediaUrl } from "./feed-media";

export const PUBLIC_MEDIA_BYTES = 16 * 1024 * 1024;
const PLAYLIST_BYTES = 256 * 1024;
const TYPES: Record<string, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"],
  audio: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4"],
  video: ["video/mp4", "video/webm", "video/ogg", "video/mp2t", "audio/mp4", "audio/aac", "audio/mpeg", "application/vnd.apple.mpegurl", "application/x-mpegurl"],
};
export function publicMediaProxyUrl(url: string, kind: string, depth = 0): string {
  return `/api/feed/media?${new URLSearchParams({url, kind, depth: String(depth)})}`;
}

export function rewriteMediaPlaylist(text: string, base: string, depth: number, sign: (url:string,kind:string,depth:number)=>string = publicMediaProxyUrl): string {
  if (!text.startsWith("#EXTM3U") || depth >= 3) throw new Error("Unsupported playlist");
  const lines = text.split(/\r?\n/);
  if (lines.length > 2048) throw new Error("Playlist too large");
  const rewrite = (value: string) => {
    const url = publicMediaUrl(new URL(value, base).href);
    if (!url) throw new Error("Unsafe playlist URL");
    return sign(url, "video", depth + 1);
  };
  return lines.map(line => {
    if (line.length > 8192) throw new Error("Playlist line too large");
    if (!line.trim()) return "";
    if (!line.startsWith("#")) return rewrite(line.trim());
    // Only known URI-bearing tags are supported. Keys, variable expansion,
    // content steering and interstitials must not trigger unproxied requests.
    if (/^#EXT-X-(KEY|SESSION-KEY|DEFINE|CONTENT-STEERING|DATERANGE)/.test(line)) throw new Error("Unsupported playlist feature");
    if (/URI=/i.test(line)) {
      if (!/^#EXT-X-(MEDIA|MAP|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT):/.test(line)) throw new Error("Unsupported playlist URI");
      let count = 0;
      const updated = line.replace(/URI="([^"\r\n]+)"/g, (_match, value: string) => { count++; return `URI="${rewrite(value)}"`; });
      if (count !== 1 || /URI=/gi.test(updated.replace(/URI="[^"]*"/g, ""))) throw new Error("Malformed playlist URI");
      return updated;
    }
    return line;
  }).join("\n");
}

export async function readMediaBytes(response: Response, limit: number, timeoutMs = 15_000, charge = (_bytes: number) => true): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel(); throw new Error("Media too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty media");
  const buffer = new Uint8Array(limit);
  let used = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, timeoutMs);
  const started = Date.now();
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (Date.now() - started >= timeoutMs) throw new Error("Media timeout");
      if (done) break;
      if (value.byteLength > limit - used) throw new Error("Media too large");
      if (!charge(value.byteLength)) throw new Error("Media quota exhausted");
      buffer.set(value, used); used += value.byteLength;
    }
    if (!used) throw new Error("Empty media");
    return buffer.slice(0, used);
  } catch (error) {
    await reader.cancel().catch(() => undefined); throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export function createMediaQueue(limit = 4, capacity = 32, timeoutMs = 5000) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return async (signal: AbortSignal): Promise<(() => void) | null> => {
    if (signal.aborted) return null;
    if (active < limit) { active++; return release; }
    if (waiting.length >= capacity) return null;
    return new Promise(resolve => {
      const remove = () => {
        const index = waiting.indexOf(ready); if (index >= 0) waiting.splice(index, 1);
        clearTimeout(timer); signal.removeEventListener("abort", remove); resolve(null);
      };
      const ready = () => {
        clearTimeout(timer); signal.removeEventListener("abort", remove); resolve(release);
      };
      const timer = setTimeout(remove, timeoutMs);
      waiting.push(ready); signal.addEventListener("abort", remove, {once:true});
    });
  };
}
const acquireMedia = createMediaQueue();
const budget = createMediaBudget();
export async function servePublicMedia(request: Request, read = fetchPublic, sign: (url:string,kind:string,depth:number)=>string = publicMediaProxyUrl): Promise<Response> {
  const input = new URL(request.url), raw = input.searchParams.get("url");
  const kind = input.searchParams.get("kind") ?? "", depthRaw = input.searchParams.get("depth") ?? "0";
  const url = publicMediaUrl(raw);
  if (!url || !Object.hasOwn(TYPES, kind) || !/^[0-3]$/.test(depthRaw)) return new Response("Invalid media request", {status:400});
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", {status:403});
  if (!budget.request()) return new Response("Media quota exhausted",{status:429,headers:{"retry-after":"60"}});
  const range = request.headers.get("range");
  let boundedRange: string | undefined;
  let rangeStart: number | undefined, rangeEnd: number | undefined, suffix: number | undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null,{status:416});
    if (match[1]) {
      rangeStart=Number(match[1]);rangeEnd=match[2] ? Number(match[2]) : rangeStart+PUBLIC_MEDIA_BYTES-1;
      if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeEnd<rangeStart || rangeEnd-rangeStart>=PUBLIC_MEDIA_BYTES)return new Response(null,{status:416});
      boundedRange=`bytes=${rangeStart}-${rangeEnd}`;
    } else {
      suffix=Number(match[2]);if(!Number.isSafeInteger(suffix) || suffix<1 || suffix>PUBLIC_MEDIA_BYTES)return new Response(null,{status:416});
      boundedRange=`bytes=-${suffix}`;
    }
  }
  const release = await acquireMedia(request.signal);
  if (!release) return new Response("Media busy", {status:429,headers:{"retry-after":"5"}});
  try {
    const upstream = await read(url, {accept:TYPES[kind].join(", "),range:boundedRange});
    const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!upstream.ok || !TYPES[kind].includes(type)) {
      await upstream.body?.cancel(); return new Response("Unsupported media", {status:415});
    }
    const playlist = type.includes("mpegurl");
    const bytes = await readMediaBytes(upstream, playlist ? PLAYLIST_BYTES : PUBLIC_MEDIA_BYTES, 15_000, budget.bytes);
    const body = playlist ? new TextEncoder().encode(rewriteMediaPlaylist(new TextDecoder("utf-8",{fatal:true}).decode(bytes), upstream.url || url, Number(depthRaw), sign)) : bytes;
    const headers = {
      "content-type":playlist ? "application/vnd.apple.mpegurl" : type,
      "content-length":String(body.byteLength), "cache-control":"no-store",
      "x-content-type-options":"nosniff", "content-security-policy":"default-src 'none'; sandbox",
      "cross-origin-resource-policy":"same-origin", "referrer-policy":"no-referrer",
    };
    if (upstream.status===206) {
      const partial=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstream.headers.get("content-range")??"");
      const start=Number(partial?.[1]),end=Number(partial?.[2]),total=Number(partial?.[3]);
      if (!range || playlist || !partial || ![start,end,total].every(Number.isSafeInteger) || start>end || end>=total || end-start+1!==body.length ||
          (suffix!==undefined ? end!==total-1 || start!==Math.max(0,total-suffix) : start!==rangeStart || end>rangeEnd!))return new Response("Invalid media range",{status:502});
      return new Response(body,{status:206,headers:{...headers,"accept-ranges":"bytes","content-range":`bytes ${start}-${end}/${total}`}});
    }
    if (range && !playlist) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, body.length - Number(match?.[2]));
      const end = match?.[1] ? (match[2] ? Math.min(body.length - 1, Number(match[2])) : body.length - 1) : body.length - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end || start >= body.length) {
        return new Response(null,{status:416,headers:{...headers,"content-length":"0","content-range":`bytes */${body.length}`}});
      }
      const selected = body.slice(start, end + 1);
      return new Response(selected,{status:206,headers:{...headers,"content-length":String(selected.length),"accept-ranges":"bytes","content-range":`bytes ${start}-${end}/${body.length}`}});
    }
    return new Response(body, {headers:{
      "content-type":playlist ? "application/vnd.apple.mpegurl" : type,
      "content-length":String(body.byteLength), "cache-control":"no-store",
      "x-content-type-options":"nosniff", "content-security-policy":"default-src 'none'; sandbox",
      "cross-origin-resource-policy":"same-origin", "referrer-policy":"no-referrer",
    }});
  } catch { return new Response("Media unavailable",{status:502}); }
  finally { release(); }
}
