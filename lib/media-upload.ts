import { wrapItemDekToReaders, type ItemReaderWrap } from "sociacl-ids";
import { parseForumObjectRecord, type UnverifiedObjectRecord } from "./identity/forum-object-record";
import { seaToPrincipalKey, isSeaPubkey } from "./identity/forum-check";
import type { SeaPair } from "./identity/sea";
import { createPrivateMediaOwner, PrivateMediaConflict } from "./media-owner-client";
import { createMediaHttpClient, type MediaCiphertextReference } from "./media-client";
import { prepareMediaFile, type MediaFileDescription } from "./media-file";
import { decryptUploadJournal, encryptUploadJournal, uploadDigest, type UploadEntry, type UploadJournal } from "./media-upload-journal";

type Owner = ReturnType<typeof createPrivateMediaOwner>;
type Epoch = Awaited<ReturnType<Owner["prepareUploadEpoch"]>>;
type Grant = Awaited<ReturnType<Owner["prepareUploadGrant"]>>;
type Draft = {version:1;tenant:string;owner:string;record:UnverifiedObjectRecord;fileKey:number[];
  description:MediaFileDescription;reference:MediaCiphertextReference;grant?:Grant;epoch?:Epoch;wrap?:ItemReaderWrap};
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
function draftValue(value:unknown,entry:UploadEntry,tenant:string):Draft {
  if(!value || typeof value!=="object" || Array.isArray(value))throw Error("Invalid recovery draft");
  const d=value as Draft, record=parseForumObjectRecord(d.record);
  if(d.version!==1 || d.tenant!==tenant || !isSeaPubkey(d.owner) || !record || record.record.object!==entry.object || record.record.owner!==d.owner ||
      !Array.isArray(d.fileKey) || d.fileKey.length!==32 || d.fileKey.some(b=>!Number.isInteger(b)||b<0||b>255) ||
      !d.reference || !/^[a-f0-9]{64}$/.test(d.reference.sha256) || d.reference.length!==entry.ciphertext.length ||
      !d.description || typeof d.description.name!=="string" || d.description.name.length>255 || typeof d.description.mediaType!=="string"){if(Array.isArray(d.fileKey))d.fileKey.fill(0);throw Error("Invalid recovery draft");}
  return d;
}
async function ownership(object:string,owner:string,issuedAt:number,pair:SeaPair) {
  const draft={object,owner,issuedAt,sig:"pending"},parsed=parseForumObjectRecord(draft);
  if(!parsed)throw Error("Invalid media ownership");
  const [x,y]=pair.pub.split(".");
  const key=await crypto.subtle.importKey("jwk",{kty:"EC",crv:"P-256",x,y,d:pair.priv,ext:false,key_ops:["sign"]},
    {name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const signature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,new Uint8Array(parsed.bytes)));
  return {...draft,sig:btoa(String.fromCharCode(...signature)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")};
}
export async function pendingMediaUpload(journal:UploadJournal,tenant:string,pair:SeaPair,signal:AbortSignal) {
  const entry=await journal.read(signal);signal.throwIfAborted();if(!entry)return null;
  const draft=draftValue(await decryptUploadJournal(entry,tenant,pair),entry,tenant);
  try {signal.throwIfAborted();return {object:entry.object,name:draft.description.name};}
  finally {draft.fileKey.fill(0);}
}
export async function discardMediaUpload(journal:UploadJournal,tenant:string,pair:SeaPair,signal:AbortSignal) {
  const entry=await journal.read(signal);if(!entry)return;
  const draft=draftValue(await decryptUploadJournal(entry,tenant,pair),entry,tenant);
  try {signal.throwIfAborted();await journal.remove(entry.revision,signal);}
  finally {draft.fileKey.fill(0);}
}

/** Explicit user invocation only. A failure retains the encrypted journal and
 * immutable signed intents. Resume probes them before any replacement write. */
export async function uploadMedia(input:{tenant:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:UploadJournal;
  file?:{bytes:Uint8Array;description:MediaFileDescription};progress?:(message:string)=>void}) {
  const {tenant,pair,fetcher,signal,journal}=input,ownerClient=createPrivateMediaOwner(fetcher),media=createMediaHttpClient(fetcher);
  let entry=await journal.read(signal),draft:Draft|undefined,key:Uint8Array|undefined,scalar:Uint8Array|undefined;
  const progress=(message:string)=>{signal.throwIfAborted();input.progress?.(message);};
  async function save() {
    signal.throwIfAborted();
    const encrypted=await encryptUploadJournal(draft!,tenant,draft!.record.object,pair);
    signal.throwIfAborted();
    entry=await journal.write({...encrypted,tenant,object:draft!.record.object,ciphertext:entry!.ciphertext},entry!.revision||null,signal);
  }
  try {
    if(entry) {
      if(input.file)throw Error("Resume or discard the existing upload first");
      draft=draftValue(await decryptUploadJournal(entry,tenant,pair),entry,tenant);
      key=new Uint8Array(draft.fileKey);
    } else {
      if(!input.file)throw Error("No pending upload");
      progress("Preparing encrypted recovery…");
      const catalog=await ownerClient.catalog(0,signal),owner=catalog.principal;
      const object=`media_${seaToPrincipalKey(owner)}_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
      const record=await ownership(object,owner,catalog.at,pair);
      const sealed=await prepareMediaFile(input.file.bytes,input.file.description,{tenant,object});key=sealed.key;
      draft={version:1,tenant,owner,record,fileKey:Array.from(key),description:{...input.file.description},reference:{sha256:sealed.sha256,length:sealed.bytes.length}};
      // Saving recovery must succeed before the first remote mutation.
      entry={revision:0,tenant,object,ciphertext:sealed.bytes,encrypted:new Uint8Array(),sha256:"",wrap:null as unknown as ItemReaderWrap};
      await save();
    }
    const d=draft,object=d.record.object;
    if(await uploadDigest(entry!.ciphertext)!==d.reference.sha256)throw Error("Recovery ciphertext changed");
    if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid signing key");
    scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
    progress("Confirming private allocation…");
    try {await ownerClient.confirmAllocation(object,d.owner,signal);}
    catch {signal.throwIfAborted();await ownerClient.allocate(d.record,signal);}
    if(!d.grant) {
      d.grant=await ownerClient.prepareUploadGrant(object,d.owner,{object,owner:d.owner,accessor:d.owner,
        from:d.record.issuedAt*1000,until:Number.MAX_SAFE_INTEGER,stated:1,epoch:1,grantRevision:1,
        itemCiphertextDigest:d.reference.sha256},scalar,signal);
      await save();
    }
    async function apply(operation:"grant"|"epoch",payload:unknown) {
      const state=await ownerClient.uploadState(object,operation,payload,signal);
      if(state==="conflict")throw new PrivateMediaConflict();
      if(state==="absent")await ownerClient.commitUploadIntent(object,d.owner,operation,payload,signal);
    }
    progress("Confirming your private grant…");await apply("grant",d.grant);
    if(!d.epoch) {
      d.epoch=await ownerClient.prepareUploadEpoch(object,d.owner,await uploadDigest(key!),scalar,signal);
      await save();
    }
    const epoch=d.epoch;
    if(epoch.ownerPub!==pair.pub || epoch.ownerEpub!==pair.epub || epoch.document.manifest.object!==object ||
        epoch.document.manifest.epoch!==1)throw new PrivateMediaConflict();
    progress("Confirming the initial epoch…");await apply("epoch",{document:epoch.document,finalization:epoch.finalization});
    if(!d.wrap) {
      const wrapped=await wrapItemDekToReaders(key!,{object,epoch:1,revisionId:epoch.document.manifest.revisionId},
        [{account:d.owner,pub:pair.pub,identityPub:pair.pub,epub:pair.epub}],[d.owner]);
      if(!wrapped.ok)throw Error("Private wrapping refused");d.wrap=wrapped.value[0];await save();
    }
    const wrap=d.wrap;
    const record=await uploadDigest(new TextEncoder().encode(JSON.stringify({wrap,reference:d.reference})));
    const metadata={reader:d.owner,record,digest:record,epoch:wrap.epoch,revisionId:wrap.revisionId,readerEpub:wrap.targetId,itemDigest:d.reference.sha256};
    progress("Confirming encrypted key storage…");
    const state=await ownerClient.uploadState(object,"wrap",metadata,signal);
    if(state==="conflict")throw new PrivateMediaConflict();
    if(state==="absent")await ownerClient.publishWrap(object,d.owner,d.owner,wrap,d.reference,signal);
    progress("Uploading encrypted file…");
    await media.register(d.record,signal);
    await media.put(object,entry!.ciphertext,d.reference,signal);
    signal.throwIfAborted();await journal.remove(entry!.revision,signal);
    return {object};
  } finally {key?.fill(0);scalar?.fill(0);draft?.fileKey.fill(0);}
}
