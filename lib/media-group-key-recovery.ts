import {createGroupWrapClient,parseGroupWrapBundle,type GroupWrapBundle} from "./media-group-wrap-client";
import {lengthPrefixed} from "sociacl-ids";
import {groupKeySnapshotId,type PrivateGroupSnapshot,type PrivateMediaManifest,type PrivateMediaFinalization} from "sociacl-ids/private-media";
import type {SeaPair} from "./identity/sea";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
import {createGroupKeyClient,parseSignedGroupKeyCommand,type SignedGroupKeyCommand} from "./media-group-key-client";
import {encryptShareJournal,decryptShareJournal,shareDigest,type ShareJournal,type ShareEntry} from "./media-share-journal";

type Draft={version:2;wraps:GroupWrapBundle|null;next:number;tenant:string;principal:string;pub:string;epub:string;command:SignedGroupKeyCommand;groupKey:number[];attemptAt:number|null;phase:"prepared"|"admitted"};
export type PendingGroupKey=Readonly<{set:string;principal:string;token:string;epoch:number;revisionId:string;phase:"prepared"|"admitted";published:number;total:number}>;
type Input={tenant:string;principal:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;clock?:()=>number};
const fail=():never=>{throw Error("Saved group key unavailable");};
const legacyFields=["version","tenant","principal","pub","epub","command","groupKey","attemptAt","phase"];
const fields=[...legacyFields,"wraps","next"];
async function hash(values:string[]){const result=lengthPrefixed(values);if(!result.ok)return fail();return shareDigest(result.value);}
function signed(key:string,signature:string,domain:string,id:string){
  const bytes=lengthPrefixed([domain,id]);
  const raw=Uint8Array.from(signature.match(/../g)!,value=>parseInt(value,16));
  const encoded=btoa(String.fromCharCode(...raw)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  if(!bytes.ok||!verifyForumKeySignature(key,encoded,bytes.value))return fail();
}
async function parse(value:unknown,entry:Pick<ShareEntry,"object">,input:Pick<Input,"tenant"|"principal"|"pair">):Promise<Draft>{
  if(value&&typeof value==="object"&&!Array.isArray(value)&&(value as {version?:unknown}).version===1&&
      Object.keys(value).length===legacyFields.length&&legacyFields.every(k=>Object.hasOwn(value,k)))
    value={...value,version:2,wraps:null,next:0};
  const d=value as Draft,{tenant,principal,pair}=input;
  if(!d||typeof d!=="object"||Array.isArray(d)||Object.keys(d).length!==fields.length||!fields.every(k=>Object.hasOwn(d,k))||
      d.version!==2||d.tenant!==tenant||d.principal!==principal||d.pub!==pair.pub||d.epub!==pair.epub||
      !["prepared","admitted"].includes(d.phase)||(d.attemptAt!==null&&(!Number.isSafeInteger(d.attemptAt)||d.attemptAt<0))||
      !Array.isArray(d.groupKey)||d.groupKey.length!==32||d.groupKey.some(n=>!Number.isInteger(n)||n<0||n>255))return fail();
  const command=parseSignedGroupKeyCommand(d.command,principal);
  if(command.set!==entry.object)return fail();
  const c=command.command as {document:{manifest:PrivateMediaManifest;snapshot:PrivateGroupSnapshot};finalization:PrivateMediaFinalization};
  const m=c.document.manifest,s=c.document.snapshot,f=c.finalization;
  if(s.ownerSigningPub!==pair.pub||s.ownerEncryptionPub!==pair.epub||groupKeySnapshotId(s)!==m.aclSnapshot)return fail();
  const secret=Uint8Array.from(d.groupKey);
  try{if(await shareDigest(secret)!==m.keyCommitment)return fail();}finally{secret.fill(0);}
  if(await hash(["s3rch-epoch-revision-v1",command.set,String(m.epoch),String(m.previousEpoch),m.deviceId,m.keyCommitment,String(m.settleWindowMs),m.aclSnapshot])!==m.revisionId||
      await hash(["s3rch-epoch-finalization-v1",command.set,String(f.epoch),String(f.previousEpoch),f.revisionId,f.previousFinalizationId,...f.candidateRevisionIds])!==f.finalizationId)return fail();
  signed(pair.pub,m.signature,"s3rch-epoch-manifest-sig-v1",m.revisionId);
  signed(pair.pub,f.signature,"s3rch-epoch-finalization-sig-v1",f.finalizationId);
  if(!Number.isSafeInteger(d.next)||d.next<0)return fail();
  if(d.wraps!==null){
    const bundle=await parseGroupWrapBundle(d.wraps,principal),members=s.members.filter(member=>member.stated===1);
    if(d.phase!=="admitted"||bundle.set!==command.set||bundle.predicate!==command.predicate||bundle.epoch!==m.epoch||
        bundle.revisionId!==m.revisionId||bundle.keyCommitment!==m.keyCommitment||bundle.aclSnapshot!==m.aclSnapshot||
        d.next>bundle.wraps.length||members.length!==bundle.wraps.length||members.some((member,i)=>
          member.accessor!==bundle.wraps[i].metadata.reader||member.encryptionPub!==bundle.wraps[i].metadata.readerEpub))return fail();
    d.wraps=bundle;
  }else if(d.next!==0)return fail();
  return {...d,command};
}
const clear=(value:unknown)=>{const key=(value as Partial<Draft>|null)?.groupKey;if(Array.isArray(key))key.fill(0);};
const pending=(d:Draft,e:ShareEntry):PendingGroupKey=>{
  const m=(d.command.command.document as {manifest:{epoch:number;revisionId:string}}).manifest;
  return {set:e.object,principal:d.principal,token:e.sha256,epoch:m.epoch,revisionId:m.revisionId,phase:d.phase,published:d.next,total:d.wraps?.wraps.length??0};
};
function matches(d:Draft,e:ShareEntry,expected:PendingGroupKey){
  const actual=pending(d,e);
  if(!expected||Object.keys(actual).some(k=>actual[k as keyof PendingGroupKey]!==expected[k as keyof PendingGroupKey]))return fail();
}
async function load(input:Input){
  const entry=await input.journal.read(input.signal);input.signal.throwIfAborted();if(!entry)return null;
  const raw=await decryptShareJournal(entry,input.tenant,input.pair,"group-key");
  try{const draft=await parse(raw,entry,input);input.signal.throwIfAborted();return {draft,entry};}
  catch(error){clear(raw);throw error;}
}
async function save(input:Input,draft:Draft,expected:Pick<ShareEntry,"revision"|"sha256">|null){
  draft=await parse(draft,{object:draft.command.set},input);
  const encrypted=await encryptShareJournal(draft,input.tenant,draft.command.set,input.pair,"group-key");input.signal.throwIfAborted();
  const entry=await input.journal.write({...encrypted,tenant:input.tenant,object:draft.command.set},expected,input.signal);
  return {draft,entry};
}
export async function pendingGroupKey(input:Input){
  const held=await load(input);try{return held?pending(held.draft,held.entry):null;}finally{clear(held?.draft);}
}
/** Keep the encrypted group secret after admission until durable wrap delivery exists. */
export async function applyGroupKey(input:Input&{command?:SignedGroupKeyCommand;groupKey?:Uint8Array;expected?:PendingGroupKey}){
  const expected=input.expected?structuredClone(input.expected):undefined;
  let held=await load(input),draft:Draft|undefined=held?.draft;
  try{
    if(held){if(input.command||input.groupKey)return fail();matches(held.draft,held.entry,expected!);}
    else{
      if(!input.command||!(input.groupKey instanceof Uint8Array)||input.groupKey.length!==32)return fail();
      draft={version:2,wraps:null,next:0,tenant:input.tenant,principal:input.principal,pub:input.pair.pub,epub:input.pair.epub,
        command:parseSignedGroupKeyCommand(input.command,input.principal),groupKey:Array.from(input.groupKey),attemptAt:null,phase:"prepared"};
      held=await save(input,draft,null);
    }
    const client=createGroupKeyClient(input.principal,input.fetcher,input.clock);
    if(held.draft.phase==="admitted"){
      if((await client.state(held.draft.command,input.signal)).state!=="applied")return fail();
      return pending(held.draft,held.entry);
    }
    await client.apply(held.draft.command,input.signal,async at=>{held=await save(input,{...held!.draft,attemptAt:Math.max(held!.draft.attemptAt??at,at)},held!.entry);});
    input.signal.throwIfAborted();
    held=await save(input,{...held.draft,phase:"admitted"},held.entry);
    return pending(held.draft,held.entry);
  }finally{clear(draft);clear(held?.draft);}
}
/** Only an unadmitted command with no live attempted fence may lose its secret. */
export async function discardGroupKey(input:Input&{expected:PendingGroupKey}){
  const expected=structuredClone(input.expected),held=await load(input);
  try{
    if(!held)return fail();matches(held.draft,held.entry,expected);
    if(held.draft.phase==="admitted")return fail();
    const state=await createGroupKeyClient(input.principal,input.fetcher,input.clock).state(held.draft.command,input.signal);
    if(state.state!=="absent"||(held.draft.attemptAt!==null&&state.at-held.draft.attemptAt<=4))return fail();
    input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);
  }finally{clear(held?.draft);}
}

/** Persist all generated wraps before publishing any; every retry reuses saved bytes. */
export async function deliverGroupKey(input:Input&{expected:PendingGroupKey}){
  const expected=structuredClone(input.expected);let held=await load(input);
  try{
    if(!held)return fail();matches(held.draft,held.entry,expected);
    if(held.draft.phase!=="admitted"||(await createGroupKeyClient(input.principal,input.fetcher,input.clock).state(held.draft.command,input.signal)).state!=="applied")return fail();
    const client=createGroupWrapClient(input.principal,input.fetcher,input.clock);
    if(!held.draft.wraps){
      const secret=Uint8Array.from(held.draft.groupKey);
      try{
        const wraps=await client.prepare({predicate:held.draft.command.predicate,set:held.draft.command.set},secret,input.signal);
        held=await save(input,{...held.draft,wraps,next:0},held.entry);
      }finally{secret.fill(0);}
    }
    while(held.draft.next<held.draft.wraps!.wraps.length){
      input.signal.throwIfAborted();
      await client.publish(held.draft.wraps!,held.draft.next,input.signal);
      held=await save(input,{...held.draft,next:held.draft.next+1},held.entry);
    }
    return pending(held.draft,held.entry);
  }finally{clear(held?.draft);}
}
/** Release the local secret only after the owner's durable current wrap opens. */
export async function finishGroupKeyDelivery(input:Input&{expected:PendingGroupKey}){
  const expected=structuredClone(input.expected),held=await load(input);
  try{
    if(!held)return fail();matches(held.draft,held.entry,expected);
    if(!held.draft.wraps||held.draft.next!==held.draft.wraps.wraps.length)return fail();
    const opened=await createGroupWrapClient(input.principal,input.fetcher,input.clock).open(
      {predicate:held.draft.command.predicate,set:held.draft.command.set},input.pair.epriv,input.pair.epub,input.signal);
    try{
      if(await shareDigest(opened)!==held.draft.wraps.keyCommitment)return fail();
      input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);
    }finally{opened.fill(0);}
  }finally{clear(held?.draft);}
}
