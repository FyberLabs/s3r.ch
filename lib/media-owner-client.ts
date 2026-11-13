import { isMediaCatalogPageNumber, parseMediaCatalogPage } from "./media-catalog";
import { signPrivateMediaGrant, signPrivateMediaEpoch, signPrivateMediaFinalization, signPrivateMediaStatus } from "sociacl-ids/private-media";
import type { ItemReaderWrap } from "sociacl-ids";
import type { MediaCiphertextReference } from "./media-client";
import { MEDIA_STORED_MAX } from "./media-crypto";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isCanonicalObjectId } from "./identity/object-id";
import { isSeaPubkey } from "./identity/forum-check";

export class PrivateMediaConflict extends Error {
  constructor() { super("Private media changed; refresh and reconcile before signing again"); }
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys.sort().join();
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const objectOK = (object: string) => object.startsWith("media_") && isCanonicalObjectId(object);

/** Owner writes never retry automatically. A lost response requires explicit
 * reconciliation against a new protected view before another signature. */
export function createPrivateMediaOwner(fetcher: typeof fetch = fetch, clock = () => performance.now() / 1000) {
  const fetchedAt = new WeakMap<object, number>();
  async function request(action: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const started=clock();
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(4000)]), encoded=JSON.stringify(body);
    if (new TextEncoder().encode(encoded).length>100000) throw Error("Private media request too large");
    deadline.throwIfAborted();
    const response=await fetcher("/api/media/owner/"+action,{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
      headers:{"Content-Type":"application/json"},body:encoded,signal:deadline});
    if(response.status!==200 || response.headers.get("content-type")?.split(";")[0]!=="application/json") {
      await response.body?.cancel().catch(()=>{});
      if(response.status===409) throw new PrivateMediaConflict();
      throw Error("Private media operation refused");
    }
    // Fetch already decodes browser compression; bound the decoded stream.
    const result=await readBoundedIdentityJson(response,262144,deadline);
    deadline.throwIfAborted();
    if(!result || typeof result!=="object" || Array.isArray(result))throw Error("Invalid private media response");
    fetchedAt.set(result,started);
    return result as Record<string,unknown>;
  }
  function current(view: Record<string,unknown>) {
    const started=fetchedAt.get(view), elapsed=started===undefined ? NaN : clock()-started;
    if(!Number.isSafeInteger(view.at) || (view.at as number)<0 || !digest(view.fence) ||
        !Number.isFinite(elapsed) || elapsed<0 || elapsed>=4)throw new PrivateMediaConflict();
  }
  async function view(object: string, owner: string, signal: AbortSignal): Promise<Record<string,unknown> & {key:string}> {
    if(!objectOK(object) || !isSeaPubkey(owner))throw Error("Invalid private media owner");
    const result=await request("view",{object},signal);current(result);
    if(!exact(result,["at","fence","snapshot","objectVersion","owner","bindings"]) || result.owner!==owner ||
        !result.bindings || typeof result.bindings!=="object" || Array.isArray(result.bindings))throw Error("Invalid private media owner view");
    const binding=(result.bindings as Record<string,unknown>)[owner];
    const pub=binding && typeof binding==="object" ? (binding as Record<string,unknown>).pub : null;
    if(typeof pub!=="string" || !isSeaPubkey(pub))throw Error("Invalid private media owner key");
    return Object.assign(result,{key:pub});
  }
  async function mutate(object: string, held: Record<string,unknown>, operation: string, payload: unknown, signal: AbortSignal) {
    current(held);signal.throwIfAborted();
    const result=await request("mutate",{object,at:held.at,fence:held.fence,operation,payload},signal);
    if(!exact(result,["accepted"]) || result.accepted!==true)throw Error("Private media write refused");
  }
  async function withKey<T>(scalar: Uint8Array, signal: AbortSignal | undefined,
    operation: (held: Uint8Array, deadline: AbortSignal)=>Promise<T>): Promise<T> {
    if(!(scalar instanceof Uint8Array) || scalar.length!==32)throw Error("Invalid private media key");
    const held=new Uint8Array(scalar),deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(10000)]);
    try { deadline.throwIfAborted();return await operation(held,deadline); }
    finally { held.fill(0); }
  }
  return Object.freeze({
    async catalog(page: number, owner: string, signal?: AbortSignal) {
      if (!isMediaCatalogPageNumber(page) || !isSeaPubkey(owner)) throw Error("Invalid media catalog request");
      const result = await request("catalog", {page}, signal ?? new AbortController().signal);
      const started = fetchedAt.get(result), elapsed = started === undefined ? NaN : clock() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 4) throw new PrivateMediaConflict();
      return parseMediaCatalogPage(result, page, owner);
    },
    async grant(object: string, owner: string, draft: unknown, scalar: Uint8Array, signal?: AbortSignal) {
      const input=structuredClone(draft);
      return withKey(scalar,signal,async(key,deadline)=>{
        const held=await view(object,owner,deadline), signed=signPrivateMediaGrant(input,key,held.key);
        if(signed.claims.object!==object || signed.claims.owner!==owner)throw Error("Private media grant binding mismatch");
        await mutate(object,held,"grant",signed,deadline);
      });
    },
    async epoch(object: string, owner: string, draft: unknown, finalizationDraft: unknown,
      scalar: Uint8Array, signal?: AbortSignal) {
      const input=structuredClone(draft), finalInput=structuredClone(finalizationDraft);
      return withKey(scalar,signal,async(key,deadline)=>{
        const held=await view(object,owner,deadline),document=signPrivateMediaEpoch(input,held.snapshot,key,held.key);
        if(document.manifest.object!==object)throw Error("Private media epoch binding mismatch");
        const m=document.manifest;
        const finalization=signPrivateMediaFinalization(finalInput,key,held.key);
        if(finalization.object!==object || finalization.epoch!==m.epoch || finalization.previousEpoch!==m.previousEpoch ||
            finalization.revisionId!==m.revisionId)throw Error("Private media finalization binding mismatch");
        await mutate(object,held,"epoch",{document,finalization},deadline);
        return {object,epoch:m.epoch,revisionId:m.revisionId};
      });
    },
    async status(object: string, reader: string, scalar: Uint8Array, signal?: AbortSignal) {
      if(!objectOK(object) || !isSeaPubkey(reader))throw Error("Invalid private media status request");
      return withKey(scalar,signal,async(key,deadline)=>{
        const held=await request("status-view",{object,reader},deadline);current(held);
        if(!exact(held,["at","fence","ownerPub","status"]) || typeof held.ownerPub!=="string" || !isSeaPubkey(held.ownerPub))throw Error("Invalid private media status view");
        const signed=signPrivateMediaStatus(held.status,key,held.ownerPub as string);
        if(signed.object!==object || signed.accessor!==reader || signed.signedAt!==(held.at as number)*1000)throw Error("Private media status binding mismatch");
        await mutate(object,held,"status",signed,deadline);
      });
    },
    async publishWrap(object: string, owner: string, reader: string, wrap: ItemReaderWrap,
      reference: MediaCiphertextReference, signal?: AbortSignal) {
      if(!exact(wrap,["object","epoch","revisionId","scope","target","targetId","wrappedKey"]) ||
          !exact(reference,["sha256","length"]) || wrap.scope!=="item-dek" || wrap.target!=="reader-epub" ||
          typeof wrap.wrappedKey!=="string" || wrap.wrappedKey.length>60000 || !/^(?:[a-f0-9]{2})+$/.test(wrap.wrappedKey) ||
          !Number.isSafeInteger(wrap.epoch) || wrap.epoch<1 || !digest(wrap.revisionId))throw Error("Invalid private media wrap material");
      const material=structuredClone({wrap,reference});
      if(!objectOK(object) || !isSeaPubkey(reader) || material.wrap.object!==object || !isSeaPubkey(material.wrap.targetId) ||
          !digest(material.reference.sha256) || !Number.isSafeInteger(material.reference.length) || material.reference.length<33 || material.reference.length>MEDIA_STORED_MAX)
        throw Error("Invalid private media wrap material");
      const bytes=new TextEncoder().encode(JSON.stringify(material));
      if(!bytes.length || bytes.length>65536)throw Error("Private media wrap too large");
      const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(10000)]);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
      const held=await view(object,owner,deadline);current(held);
      const result=await request("publish-wrap",{object,at:held.at,fence:held.fence,
        metadata:{reader,record:hash,digest:hash,epoch:material.wrap.epoch,revisionId:material.wrap.revisionId,
          readerEpub:material.wrap.targetId,itemDigest:material.reference.sha256},
        wrapBase64:btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(""))},deadline);
      if(!exact(result,["record","digest"]) || result.record!==hash || result.digest!==hash)throw Error("Private media publication refused");
      return hash;
    },
  });
}
