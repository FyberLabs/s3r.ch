import { createHash } from "node:crypto";
import { RECORD_BYTES_MAX } from "./record-store";

async function bounded(response: Response, limit: number) {
  if (!response.body || ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new Error();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[1-9][0-9]{0,8}$/.test(length) || Number(length) > limit)) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error();
      chunks.push(new Uint8Array(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size || (length !== null && size !== Number(length))) throw new Error();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Consumes only a descriptor returned by the authenticated tenant API. */
export async function readCacheAccess(response: Response, tenant: string, name: string, fetcher: typeof fetch, signal: AbortSignal) {
  // Old service versions lack this additive endpoint; confirm absence through
  // their established byte API. Unsupported providers retain that API too.
  if ([404, 501].includes(response.status)) return undefined;
  if (response.status !== 200) throw new Error();
  const grant = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bounded(response, 16384)));
  const now = Math.floor(Date.now() / 1000);
  if (!grant || grant.version !== 1 || grant.provider !== "azure_blob" || grant.method !== "GET" || grant.encoding !== "spanrec1" ||
      !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= now || grant.expires_at > now + 65 ||
      !Number.isSafeInteger(grant.size) || grant.size <= 40 || grant.size > RECORD_BYTES_MAX + 40 ||
      typeof grant.url !== "string" || grant.url.length > 8192 || !grant.headers ||
      Object.keys(grant.headers).length !== 1 || typeof grant.headers["If-Match"] !== "string" ||
      !/^"[A-Za-z0-9._:-]{1,128}"$/.test(grant.headers["If-Match"])) throw new Error();
  const url = new URL(grant.url);
  const expected = "/tenant-records/v1/" + tenant.replaceAll("-", "") + "/cache/" + name;
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
      !/^\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])\//.test(url.pathname) ||
      url.pathname.slice(url.pathname.indexOf("/", 1)) !== expected) throw new Error();
  for (const [key, value] of [["sp", "r"], ["sr", "b"], ["spr", "https"]]) {
    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) throw new Error();
  }
  const expiry = url.searchParams.getAll("se");
  if (expiry.length !== 1 || Math.floor(Date.parse(expiry[0]) / 1000) !== grant.expires_at ||
      url.searchParams.getAll("sig").length !== 1 || !url.searchParams.get("sig")) throw new Error();
  signal.throwIfAborted();
  const direct = await fetcher(url.href, { method: "GET", headers: { "If-Match": grant.headers["If-Match"], "Accept-Encoding": "identity" },
    redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal });
  try {
    if (direct.status !== 200 || direct.headers.get("etag") !== grant.headers["If-Match"]) throw new Error();
    const bytes = await bounded(direct, grant.size);
    signal.throwIfAborted();
    if (bytes.length !== grant.size || new TextDecoder().decode(bytes.subarray(0, 8)) !== "SPANREC1") throw new Error();
    return { bytes: bytes.slice(40), revision: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    if (direct.body && !direct.body.locked) await direct.body.cancel().catch(() => {});
  }
}
