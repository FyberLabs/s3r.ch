import { isCanonicalObjectId } from "./identity/object-id";
import { parseForumObjectRecord, type UnverifiedObjectRecord } from "./identity/forum-object-record";
import { MEDIA_STORED_MAX } from "./media-crypto";

export type MediaCiphertextReference = Readonly<{ sha256: string; length: number }>;
const objectOK = (value: string) => value.startsWith("media_") && isCanonicalObjectId(value);
const referenceOK = (value: MediaCiphertextReference) => value && /^[a-f0-9]{64}$/.test(value.sha256) &&
  Number.isSafeInteger(value.length) && value.length >= 33 && value.length <= MEDIA_STORED_MAX;
const digest = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
const envelope = (bytes: Uint8Array) => bytes[0] === 0x73 && bytes[1] === 0x33 && bytes[2] === 0x6d && bytes[3] === 1;
/** Same-origin ciphertext transport only. Keep DEKs and reader wraps out of these
 * requests. The reference must come from private verified grant material; this
 * client does not establish current Check, epoch status or decryption authority. */
export function createMediaHttpClient(fetcher: typeof fetch = fetch) {
  const address = (object: string) => {
    if (!objectOK(object)) throw Error("Invalid media object");
    return `/api/media/${encodeURIComponent(object)}`;
  };
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
  async function write(object: string, method: "POST" | "PUT" | "DELETE", body: BodyInit, headers: HeadersInit, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await fetcher(address(object), { method, body, headers, signal,
      credentials: "same-origin", redirect: "error", cache: "no-store" });
    try {
      signal.throwIfAborted();
      if (response.status !== (method === "DELETE" ? 204 : 201)) throw Error("Media write refused");
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  return Object.freeze({
    async register(input: UnverifiedObjectRecord, signal?: AbortSignal) {
      const parsed = parseForumObjectRecord(input);
      if (!parsed || !objectOK(parsed.record.object)) throw Error("Invalid media ownership record");
      return write(parsed.record.object, "POST", JSON.stringify(parsed.record), { "Content-Type": "application/json" }, signalFor(signal));
    },
    async removeRegistration(input: UnverifiedObjectRecord, signal?: AbortSignal) {
      const parsed = parseForumObjectRecord(input);
      if (!parsed || !objectOK(parsed.record.object)) throw Error("Invalid media ownership record");
      return write(parsed.record.object, "DELETE", JSON.stringify(parsed.record), { "Content-Type": "application/json" }, signalFor(signal));
    },
    async put(object: string, bytes: Uint8Array, expected: MediaCiphertextReference, signal?: AbortSignal) {
      address(object);
      const reference = { ...expected };
      if (!referenceOK(reference) || !(bytes instanceof Uint8Array) || bytes.length !== reference.length) throw Error("Invalid media ciphertext");
      const held = new Uint8Array(bytes), deadline = signalFor(signal);
      deadline.throwIfAborted();
      if (!envelope(held) || await digest(held) !== reference.sha256) throw Error("Invalid media ciphertext");
      // Browsers set Content-Length from the immutable body; it is a forbidden
      // script-controlled header. No plaintext metadata or key material is sent.
      return write(object, "PUT", held, { "Content-Type": "application/octet-stream", "X-Media-SHA256": reference.sha256 }, deadline);
    },
    async get(object: string, expected: MediaCiphertextReference, signal?: AbortSignal): Promise<Uint8Array> {
      const url = address(object), reference = { ...expected };
      if (!referenceOK(reference)) throw Error("Invalid media reference");
      const deadline = signalFor(signal); deadline.throwIfAborted();
      const response = await fetcher(url, { method: "GET", headers: { Accept: "application/octet-stream" },
        credentials: "same-origin", redirect: "error", cache: "no-store", signal: deadline });
      if (response.status !== 200 || response.headers.get("content-type") !== "application/octet-stream" ||
          response.headers.get("content-length") !== String(reference.length) || response.headers.get("etag") !== `"${reference.sha256}"` ||
          ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) {
        await response.body?.cancel().catch(() => {}); throw Error("Media read refused");
      }
      const reader = response.body.getReader(), bytes = new Uint8Array(reference.length); let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      deadline.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          deadline.throwIfAborted(); const part = await reader.read(); deadline.throwIfAborted();
          if (part.done) break;
          if (size + part.value.length > bytes.length) throw Error("Invalid media ciphertext");
          bytes.set(part.value, size); size += part.value.length;
        }
        if (size !== bytes.length || !envelope(bytes) || await digest(bytes) !== reference.sha256) throw Error("Invalid media ciphertext");
        deadline.throwIfAborted(); return bytes;
      } finally { deadline.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    },
  });
}
