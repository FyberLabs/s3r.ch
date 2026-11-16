import {openItemDekReaderWrap} from "sociacl-ids";
import {wrapItemDekToGroupEpoch} from "sociacl-ids/group-wrap";
import {createGroupWrapClient} from "./media-group-wrap-client";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit,type GroupCommandAction} from "./media-group-command";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {shareDigest} from "./media-share-journal";
import {MEDIA_STORED_MAX} from "./media-crypto";
import type {MediaGroupScope} from "./media-group";
import type {SeaPair} from "./identity/sea";
export type ItemWrapTarget=MediaGroupScope & {object:string;reader:string};
export type ItemWrapBundle=ItemWrapTarget & {version:1;ownerPub:string;metadata:Record<string,unknown>;payload:string};
const fail=():never=>{throw Error("Group item key delivery could not be confirmed");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const decode=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
const encode=(v:Uint8Array)=>{let s="";for(const b of v)s+=String.fromCharCode(b);return btoa(s);};
function material(bytes:Uint8Array,itemDigest:unknown){
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(value,["wrap","reference"])||!exact(value.reference,["sha256","length"])||value.reference.sha256!==itemDigest||
      !Number.isSafeInteger(value.reference.length)||(value.reference.length as number)<33||(value.reference.length as number)>MEDIA_STORED_MAX)return fail();
  return value;
}
export async function parseItemWrapBundle(input:unknown,principal:string):Promise<ItemWrapBundle>{
  const b=structuredClone(input);
  if(!exact(b,["version","ownerPub","object","predicate","set","reader","metadata","payload"])||b.version!==1)return fail();
  const target={object:b.object,predicate:b.predicate,set:b.set,reader:b.reader};
  parseGroupCommand("item-wrap-publish",{...target,at:0,fence:'0'.repeat(64),metadata:b.metadata,payload:b.payload},principal);
  parseGroupCommandResult("item-wrap-view",{at:0,fence:'0'.repeat(64),ownerPub:b.ownerPub,metadata:Object.fromEntries(Object.entries(b.metadata as Record<string,unknown>).filter(([key])=>key!=="digest"))},target,0);
  const metadata=b.metadata as Record<string,unknown>,bytes=decode(b.payload as string);
  if(await shareDigest(bytes)!==metadata.digest)return fail();
  const value=material(bytes,metadata.itemDigest),w=value.wrap;
  if(!exact(w,["object","group","epoch","revisionId","scope","target","targetId","wrappedKey"])||w.object!==b.object||w.group!==b.set||w.epoch!==metadata.itemEpoch||
      w.revisionId!==metadata.itemRevisionId||w.scope!=="item-dek"||w.target!=="group-epoch"||w.targetId!==b.set||typeof w.wrappedKey!=="string"||
      w.wrappedKey.length>16384||!/^(?:[a-f0-9]{2}){29,}$/.test(w.wrappedKey))return fail();
  return b as ItemWrapBundle;
}
export function createItemWrapClient(principal:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000){
  const deadline=(signal?:AbortSignal)=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  async function request(action:GroupCommandAction,body:Record<string,unknown>,signal:AbortSignal){
    const parsed=parseGroupCommand(action,body,principal),raw=JSON.stringify(parsed);
    if(new TextEncoder().encode(raw).length>groupRequestLimit(action))return fail();signal.throwIfAborted();
    const response=await fetcher('/api/media/groups/'+action,{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:raw});
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const value=parseGroupCommandResult(action,await readBoundedIdentityJson(response,groupResponseLimit(action),signal),parsed,clock(),principal);
    signal.throwIfAborted();return value;
  }
  return Object.freeze({
    async prepare(target:ItemWrapTarget,pair:SeaPair,signal?:AbortSignal):Promise<ItemWrapBundle>{
      const body=parseGroupCommand("item-wrap-view",target,principal),held=deadline(signal),{pub,epub,epriv}=pair;
      const view=await request("item-wrap-view",body,held),metadata=view.metadata as Record<string,unknown>;
      if(view.ownerPub!==pub)return fail();
      const scope={predicate:body.predicate as MediaGroupScope["predicate"],set:body.set as string};
      const owner=await request("item-owner-wrap-read",{object:body.object,...scope},held);
      if(owner.reader_epub!==epub||owner.epoch!==metadata.itemEpoch||owner.revision_id!==metadata.itemRevisionId||owner.item_digest!==metadata.itemDigest)return fail();
      const original=material(decode(owner.payload as string),metadata.itemDigest);
      const opened=await openItemDekReaderWrap(original.wrap,epriv,epub,{object:body.object as string,epoch:metadata.itemEpoch as number,revisionId:metadata.itemRevisionId as string});
      if(!opened.ok)return fail();
      try{
        if(await shareDigest(opened.value)!==owner.key_commitment)return fail();
        const group=await createGroupWrapClient(principal,fetcher,clock).openCurrent(scope,epriv,epub,held);
        try{
          if(group.epoch!==metadata.groupEpoch||group.revisionId!==metadata.groupRevisionId||group.keyCommitment!==metadata.groupKeyCommitment)return fail();
          const wrapped=await wrapItemDekToGroupEpoch(opened.value,group.key,{object:body.object,group:body.set,epoch:metadata.itemEpoch,revisionId:metadata.itemRevisionId});
          if(!wrapped.ok)return fail();
          const final=await request("item-wrap-view",body,held);
          if(final.ownerPub!==pub||Object.keys(metadata).some(key=>(final.metadata as Record<string,unknown>)[key]!==metadata[key])||clock()>=group.expiresAt||clock()>=(owner.expires_at as number))return fail();
          const bytes=new TextEncoder().encode(JSON.stringify({wrap:wrapped.value,reference:original.reference}));
          const bundle=await parseItemWrapBundle({version:1,ownerPub:pub,...body,metadata:{...metadata,digest:await shareDigest(bytes)},payload:encode(bytes)},principal);
          held.throwIfAborted();return bundle;
        }finally{group.key.fill(0);}
      }finally{opened.value.fill(0);}
    },
    async publish(input:ItemWrapBundle,signal?:AbortSignal){
      const b=await parseItemWrapBundle(input,principal),held=deadline(signal),target={object:b.object,predicate:b.predicate,set:b.set,reader:b.reader};
      const view=await request("item-wrap-view",target,held),metadata=view.metadata as Record<string,unknown>;
      if(view.ownerPub!==b.ownerPub||Object.keys(metadata).some(key=>metadata[key]!==b.metadata[key]))return fail();
      // Reuse the saved opaque bytes. A new read fence never rewraps the key.
      await request("item-wrap-publish",{...target,at:view.at,fence:view.fence,metadata:b.metadata,payload:b.payload},held);
    },
  });
}
