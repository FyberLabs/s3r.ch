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

export function rewriteMediaPlaylist(text: string, base: string, depth: number): string {
  if (!text.startsWith("#EXTM3U") || depth >= 3) throw new Error("Unsupported playlist");
  const lines = text.split(/\r?\n/);
  if (lines.length > 2048) throw new Error("Playlist too large");
  const rewrite = (value: string) => {
    const url = publicMediaUrl(new URL(value, base).href);
    if (!url) throw new Error("Unsafe playlist URL");
    return publicMediaProxyUrl(url, "video", depth + 1);
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

export async function readMediaBytes(response: Response, limit: number, timeoutMs = 15_000): Promise<Uint8Array<ArrayBuffer>> {
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
export async function servePublicMedia(request: Request, read = fetchPublic): Promise<Response> {
  const input = new URL(request.url), raw = input.searchParams.get("url");
  const kind = input.searchParams.get("kind") ?? "", depthRaw = input.searchParams.get("depth") ?? "0";
  const url = publicMediaUrl(raw);
  if (!url || !Object.hasOwn(TYPES, kind) || !/^[0-3]$/.test(depthRaw)) return new Response("Invalid media request", {status:400});
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", {status:403});
  const release = await acquireMedia(request.signal);
  if (!release) return new Response("Media busy", {status:429,headers:{"retry-after":"5"}});
  try {
    const upstream = await read(url, {accept:TYPES[kind].join(", ")});
    const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!upstream.ok || !TYPES[kind].includes(type)) {
      await upstream.body?.cancel(); return new Response("Unsupported media", {status:415});
    }
    const playlist = type.includes("mpegurl");
    const bytes = await readMediaBytes(upstream, playlist ? PLAYLIST_BYTES : PUBLIC_MEDIA_BYTES);
    const body = playlist ? new TextEncoder().encode(rewriteMediaPlaylist(new TextDecoder("utf-8",{fatal:true}).decode(bytes), upstream.url || url, Number(depthRaw))) : bytes;
    return new Response(body, {headers:{
      "content-type":playlist ? "application/vnd.apple.mpegurl" : type,
      "content-length":String(body.byteLength), "cache-control":"no-store",
      "x-content-type-options":"nosniff", "content-security-policy":"default-src 'none'; sandbox",
      "cross-origin-resource-policy":"same-origin", "referrer-policy":"no-referrer",
    }});
  } catch { return new Response("Media unavailable",{status:502}); }
  finally { release(); }
}
