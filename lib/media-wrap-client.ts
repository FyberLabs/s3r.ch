import { openItemDekReaderWrap, wrapItemDekToReaders } from "sociacl-ids";
import { signPrivateMediaEpoch, signPrivateMediaFinalization } from "sociacl-ids/private-media";
import { openMedia } from "./media-crypto";
import { parseMediaSharePlan } from "./media-share";
import { uploadDigest } from "./media-upload-journal";
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
  return Object.freeze({
    async prepareSharing(object:string,tenant:string,epriv:string,epub:string,planInput:unknown,owner:string,recipient:string,scalar:Uint8Array,signal:AbortSignal,remove=false) {
      const plan=parseMediaSharePlan(planInput,object,owner,recipient,remove),key=new Uint8Array(scalar);
      let dek:Uint8Array|undefined;
      try {
        signal.throwIfAborted();
        const initial=await delivery(object,epub,signal),stored=await ciphertext.get(object,initial.reference,signal);
        const current=await delivery(object,epub,signal);
        if(current.encoded!==initial.encoded||current.context.epoch!==plan.previousEpoch||
            plan.grants.some(g=>g.itemCiphertextDigest!==current.reference.sha256))throw Error("Private media changed");
        if(clock()>=current.expiresAt)throw Error("Private media expired");
        const opened=await openItemDekReaderWrap(current.wrap,epriv,epub,current.context);
        if(!opened.ok)throw Error("Private wrapping refused");dek=opened.value;
        const plaintext=await openMedia(stored,current.reference.sha256,dek,{tenant,object});plaintext.fill(0);
        signal.throwIfAborted();
        const epoch=plan.previousEpoch+1;
        const document=signPrivateMediaEpoch({object,previousEpoch:plan.previousEpoch,epoch,deviceId:"s3rch-share",
          keyCommitment:await uploadDigest(dek),settleWindowMs:3600000},plan.snapshot,key,plan.ownerPub);
        const revisionId=document.manifest.revisionId;
        const finalization=signPrivateMediaFinalization({object,previousEpoch:plan.previousEpoch,epoch,revisionId,
          candidateRevisionIds:[revisionId],previousFinalizationId:plan.previousFinalizationId},key,plan.ownerPub);
        const active=plan.grants.filter(g=>g.stated===1);
        const readers=active.map(g=>({account:g.accessor,identityPub:plan.bindings[g.accessor].pub,
          pub:plan.bindings[g.accessor].pub,epub:plan.bindings[g.accessor].epub}));
        const wrapped=await wrapItemDekToReaders(dek,{object,epoch,revisionId},readers,active.map(g=>g.accessor));
        if(!wrapped.ok)throw Error("Private wrapping refused");
        if(clock()>=current.expiresAt)throw Error("Private media expired");
        const final=await delivery(object,epub,signal);
        if(final.encoded!==current.encoded||final.context.epoch!==current.context.epoch||final.context.revisionId!==current.context.revisionId||clock()>=final.expiresAt)
          throw Error("Private media changed");
        signal.throwIfAborted();
        return {document,finalization,wraps:wrapped.value,reference:current.reference};
      } finally {key.fill(0);dek?.fill(0);}
    },
    async open(object: string, tenant: string, epriv: string, epub: string, signal?: AbortSignal) {
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
