import type { ItemReaderWrap, ItemWrapContext } from "sociacl-ids";
import { createMediaHttpClient, type MediaCiphertextReference } from "./media-client";
import { openMediaFile } from "./media-file";
import { isCanonicalObjectId } from "./identity/object-id";

const LIMIT = 100_000;
type Delivery = Readonly<{ context: ItemWrapContext; readerEpub: string; expiresAt: number;
  wrap: ItemReaderWrap; reference: MediaCiphertextReference; encoded: string }>;
const fields = (value: unknown, names: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === names.sort().join();

/** The endpoint supplies current authorization independently of stored wrap labels.
 * It must be backed by the protected ACL source, never a public feed record. */
export function createPrivateMediaReader(fetcher: typeof fetch = fetch, clock = () => Date.now() / 1000) {
  const ciphertext = createMediaHttpClient(fetcher);
  async function delivery(object: string, epub: string, signal: AbortSignal): Promise<Delivery> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    signal.throwIfAborted();
    const response = await fetcher("/api/media/read-wrap", { method: "POST", credentials: "same-origin",
      redirect: "error", cache: "no-store", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object }) });
    // Fetch exposes decoded bytes even when Content-Encoding is retained. Bound
    // that decoded stream below; browsers cannot request identity encoding.
    if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== "application/json" || !response.body) {
      await response.body?.cancel().catch(() => {}); throw Error("Private media unavailable");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
        if (part.done) break;
        size += part.value.length; if (size > LIMIT) throw Error("Private media unavailable");
        chunks.push(part.value);
      }
    } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!fields(data, ["context", "readerEpub", "expiresAt", "wrapBase64"]) ||
        !fields(data.context, ["object", "epoch", "revisionId"]) || data.context.object !== object ||
        !Number.isSafeInteger(data.context.epoch) || (data.context.epoch as number) < 1 ||
        typeof data.context.revisionId !== "string" || !/^[a-f0-9]{64}$/.test(data.context.revisionId) ||
        data.readerEpub !== epub || typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= clock() || data.expiresAt > clock() + 3 || typeof data.wrapBase64 !== "string" ||
        data.wrapBase64.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.wrapBase64))
      throw Error("Private media unavailable");
    const raw = Uint8Array.from(atob(data.wrapBase64), c => c.charCodeAt(0));
    if (!raw.length || raw.length > 65536) throw Error("Private media unavailable");
    const material: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!fields(material, ["wrap", "reference"]) || !fields(material.reference, ["sha256", "length"]) ||
        typeof material.reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(material.reference.sha256) ||
        !Number.isSafeInteger(material.reference.length) || (material.reference.length as number) < 33 ||
        !fields(material.wrap, ["epoch", "object", "revisionId", "scope", "target", "targetId", "wrappedKey"]))
      throw Error("Private media unavailable");
    return Object.freeze({ context: data.context as ItemWrapContext, readerEpub: epub, expiresAt: data.expiresAt,
      wrap: material.wrap as ItemReaderWrap, reference: material.reference as MediaCiphertextReference, encoded: data.wrapBase64 });
  }
  return Object.freeze({ async open(object: string, tenant: string, epriv: string, epub: string, signal?: AbortSignal) {
    if (!object.startsWith("media_") || !isCanonicalObjectId(object)) throw Error("Invalid media object");
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
    // The first authorization supplies the private ciphertext reference. Fetch
    // ciphertext before obtaining the short-lived context used for decryption.
    const initial = await delivery(object, epub, deadline);
    const stored = await ciphertext.get(object, initial.reference, deadline);
    const current = await delivery(object, epub, deadline);
    if (current.encoded !== initial.encoded) throw Error("Private media changed");
    deadline.throwIfAborted();
    if (clock() >= current.expiresAt) throw Error("Private media expired");
    const opened = await openMediaFile(stored, current.reference.sha256, current.wrap, epriv, epub,
      { tenant, object }, current.context);
    try {
      deadline.throwIfAborted();
      if (clock() >= current.expiresAt) throw Error("Private media expired");
      const final = await delivery(object, epub, deadline);
      if (final.encoded !== current.encoded || final.context.epoch !== current.context.epoch ||
          final.context.revisionId !== current.context.revisionId) throw Error("Private media changed");
      deadline.throwIfAborted();
      if (clock() >= final.expiresAt) throw Error("Private media expired");
      return opened;
    } catch (error) { opened.bytes.fill(0); throw error; }
  } });
}
