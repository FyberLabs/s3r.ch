import {parseOwnerWrapResult} from "./media-group-owner-wrap";
import {openItemDekReaderWrap,wrapItemDekToReaders,type ItemReaderWrap} from "sociacl-ids";
import type {SeaPair} from "./identity/sea";
import {prepareGroupItemEpoch} from "./media-group-item-epoch-signing";
import {parseSignedItemEpoch,type SignedItemEpoch} from "./media-group-item-epoch-command";
import {createItemEpochClient} from "./media-group-item-epoch-client";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {createPrivateMediaOwner,PrivateMediaConflict} from "./media-owner-client";
import {encryptShareJournal,decryptShareJournal,shareDigest,type ShareJournal,type ShareEntry} from "./media-share-journal";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {MEDIA_STORED_MAX} from "./media-crypto";
import type {PendingItemEpoch} from "./media-group-item-epoch-recovery";
const purpose="group-item-epoch-delivery" as const;
type Input={tenant:string;principal:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;clock?:()=>number};
type Draft={version:1;tenant:string;principal:string;pub:string;epub:string;command:SignedItemEpoch;wraps:ItemReaderWrap[];reference:{sha256:string;length:number}};
const fail=():never=>{throw Error("Group access delivery unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function parse(value:unknown,input:Input,entry:Pick<ShareEntry,"object">):Draft{
  const d=value as Draft;
  if(!d||d.version!==1||d.tenant!==input.tenant||d.principal!==input.principal||d.pub!==input.pair.pub||d.epub!==input.pair.epub)return fail();
  const command=parseSignedItemEpoch(d.command,input.principal),object=command.body.object as string;
  const plan=command.plan as {ownerPub:string;bindings:Record<string,{pub:string;epub:string}>;grants:{accessor:string;stated:number;itemCiphertextDigest:string}[]};
  const manifest=(command.body.payload as {document:{manifest:{epoch:number;revisionId:string}}}).document.manifest;
  const active=plan.grants.filter(g=>g.stated===1);
  if(object!==entry.object||plan.ownerPub!==input.pair.pub||plan.bindings[input.principal]?.epub!==input.pair.epub||
      !exact(d.reference,["sha256","length"])||!Number.isSafeInteger(d.reference.length)||d.reference.length<33||d.reference.length>MEDIA_STORED_MAX||
      plan.grants.some(g=>g.itemCiphertextDigest!==d.reference.sha256)||!Array.isArray(d.wraps)||d.wraps.length!==active.length)return fail();
  for(let i=0;i<active.length;i++){
    const w=d.wraps[i];
    if(!exact(w,["object","epoch","revisionId","scope","target","targetId","wrappedKey"])||w.object!==object||w.epoch!==manifest.epoch||w.revisionId!==manifest.revisionId||
        w.scope!=="item-dek"||w.target!=="reader-epub"||w.targetId!==plan.bindings[active[i].accessor].epub||typeof w.wrappedKey!=="string"||
        w.wrappedKey.length>60000||!/^(?:[a-f0-9]{2})+$/.test(w.wrappedKey))return fail();
  }
  return {...d,command};
}
function summary(d:Draft,e:ShareEntry):PendingItemEpoch{
  const b=d.command.body,m=(b.payload as {document:{manifest:{epoch:number}}}).document.manifest;
  return {object:b.object as string,predicate:b.predicate as string,set:b.set as string,epoch:m.epoch,token:e.sha256};
}
function match(d:Draft,e:ShareEntry,expected?:PendingItemEpoch){
  const actual=summary(d,e);if(!expected||Object.keys(actual).some(k=>actual[k as keyof PendingItemEpoch]!==expected[k as keyof PendingItemEpoch]))return fail();
}
async function load(input:Input){
  const entry=await input.journal.read(input.signal);input.signal.throwIfAborted();if(!entry)return null;
  const draft=parse(await decryptShareJournal(entry,input.tenant,input.pair,purpose),input,entry);input.signal.throwIfAborted();return {entry,draft};
}
async function ownerMaterial(input:Input,object:string,scope:MediaGroupScope){
  const clock=input.clock??(()=>Date.now()/1000),signal=AbortSignal.any([input.signal,AbortSignal.timeout(4000)]);
  signal.throwIfAborted();
  const response=await input.fetcher("/api/media/groups/item-owner-wrap-read",{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal,
    headers:{"Content-Type":"application/json"},body:JSON.stringify({object,...scope})});
  if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){await response.body?.cancel().catch(()=>{});return fail();}
  const v=parseOwnerWrapResult(await readBoundedIdentityJson(response,92160,signal),{object,...scope},clock());
  if(v.reader_epub!==input.pair.epub)return fail();
  const bytes=Uint8Array.from(atob(v.payload as string),c=>c.charCodeAt(0));if(bytes.length>65536||btoa(String.fromCharCode(...bytes))!==v.payload)return fail();
  const material=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!exact(material,["wrap","reference"])||!exact(material.reference,["sha256","length"])||material.reference.sha256!==v.item_digest||
      !Number.isSafeInteger(material.reference.length)||(material.reference.length as number)<33||(material.reference.length as number)>MEDIA_STORED_MAX)return fail();
  signal.throwIfAborted();return {view:v,wrap:material.wrap,reference:material.reference as Draft["reference"]};
}
export async function pendingEpochDelivery(input:Input){const held=await load(input);return held?summary(held.draft,held.entry):null;}
export async function applyEpochDelivery(input:Input&{scalar:Uint8Array;target?:{object:string;predicate:MediaGroupScope["predicate"];set:string};expected?:PendingItemEpoch}){
  const clock=input.clock??(()=>Date.now()/1000),expected=structuredClone(input.expected),target=structuredClone(input.target);
  let held=await load(input);
  if(held){if(target)return fail();match(held.draft,held.entry,expected);}
  else{
    if(!target)return fail();const {object}=target,scope=parseMediaGroupScope({predicate:target.predicate,set:target.set});
    const current=await ownerMaterial(input,object,scope);
    const opened=await openItemDekReaderWrap(current.wrap,input.pair.epriv,input.pair.epub,{object,epoch:current.view.epoch as number,revisionId:current.view.revision_id as string});
    if(!opened.ok)return fail();
    try{
      if(await shareDigest(opened.value)!==current.view.key_commitment)return fail();
      const command=await prepareGroupItemEpoch(object,scope,input.principal,crypto.randomUUID(),input.scalar,input.fetcher,clock,input.signal);
      const plan=command.plan as {previousEpoch:number;keyCommitment:string;grants:{accessor:string;stated:number;itemCiphertextDigest:string}[];bindings:Record<string,{pub:string;epub:string}>};
      const manifest=(command.body.payload as {document:{manifest:{epoch:number;revisionId:string}}}).document.manifest;
      if(plan.previousEpoch!==current.view.epoch||plan.keyCommitment!==current.view.key_commitment||plan.grants.some(g=>g.itemCiphertextDigest!==current.reference.sha256))return fail();
      const active=plan.grants.filter(g=>g.stated===1),readers=active.map(g=>({account:g.accessor,pub:plan.bindings[g.accessor].pub,identityPub:plan.bindings[g.accessor].pub,epub:plan.bindings[g.accessor].epub}));
      const wrapped=await wrapItemDekToReaders(opened.value,{object,epoch:manifest.epoch,revisionId:manifest.revisionId},readers,active.map(g=>g.accessor));
      if(!wrapped.ok)return fail();
      const final=await ownerMaterial(input,object,scope);
      if(final.view.payload!==current.view.payload||final.view.key_commitment!==current.view.key_commitment||final.view.epoch!==current.view.epoch||final.view.revision_id!==current.view.revision_id)return fail();
      const draft=parse({version:1,tenant:input.tenant,principal:input.principal,pub:input.pair.pub,epub:input.pair.epub,command,wraps:wrapped.value,reference:current.reference},input,{object});
      const encrypted=await encryptShareJournal(draft,input.tenant,object,input.pair,purpose);input.signal.throwIfAborted();
      const entry=await input.journal.write({...encrypted,tenant:input.tenant,object},null,input.signal);held={entry,draft};
    }finally{opened.value.fill(0);}
  }
  const {draft,entry}=held;
  await createItemEpochClient(input.principal,input.fetcher,clock).apply(draft.command,input.signal);
  const owner=createPrivateMediaOwner(input.fetcher),object=draft.command.body.object as string;
  const grants=(draft.command.plan.grants as {accessor:string;stated:number}[]).filter(g=>g.stated===1);let pending=false;
  for(let i=0;i<grants.length;i++){
    try{await owner.publishShareWrap(object,input.principal,grants[i].accessor,draft.wraps[i],draft.reference,input.signal);}
    catch(error){input.signal.throwIfAborted();if(error instanceof PrivateMediaConflict)throw error;pending=true;}
  }
  for(const grant of grants){
    try{await owner.status(object,grant.accessor,input.scalar,input.signal);}
    catch(error){input.signal.throwIfAborted();if(error instanceof PrivateMediaConflict)throw error;pending=true;}
  }
  input.signal.throwIfAborted();if(!pending)await input.journal.remove(entry,input.signal);
  return {state:"applied" as const,pending};
}
export async function discardEpochDelivery(input:Input&{expected:PendingItemEpoch}){
  const held=await load(input);if(!held)return fail();match(held.draft,held.entry,structuredClone(input.expected));
  const state=await createItemEpochClient(input.principal,input.fetcher,input.clock).state(held.draft.command,input.signal);
  // Once admitted, these may be the only recoverable copies of replacement wraps.
  if(state.state!=="absent"||state.at-(held.draft.command.body.at as number)<=4)return fail();
  input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);return state;
}
