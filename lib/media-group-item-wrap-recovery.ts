import type {SeaPair} from "./identity/sea";
import {createItemWrapClient,parseItemWrapBundle,type ItemWrapBundle} from "./media-group-item-wrap-client";
import {encryptShareJournal,decryptShareJournal,type ShareJournal,type ShareEntry} from "./media-share-journal";
type Input={tenant:string;principal:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;clock?:()=>number};
type Draft={version:1;tenant:string;principal:string;pub:string;epub:string;bundle:ItemWrapBundle};
export type PendingItemWrap={object:string;predicate:string;set:string;reader:string;token:string};
const fail=():never=>{throw Error("Saved group item key delivery unavailable");};
async function parse(value:unknown,entry:Pick<ShareEntry,"object">,input:Input):Promise<Draft>{
  const d=value as Draft;
  if(!d||d.version!==1||d.tenant!==input.tenant||d.principal!==input.principal||d.pub!==input.pair.pub||d.epub!==input.pair.epub)return fail();
  const bundle=await parseItemWrapBundle(d.bundle,input.principal);
  if(bundle.ownerPub!==input.pair.pub||bundle.object!==entry.object)return fail();return {...d,bundle};
}
function pending(d:Draft,e:ShareEntry):PendingItemWrap{
  const {object,predicate,set,reader}=d.bundle;return {object,predicate,set,reader,token:e.sha256};
}
function matches(d:Draft,e:ShareEntry,expected?:PendingItemWrap){
  const actual=pending(d,e);
  if(!expected||Object.keys(actual).some(k=>actual[k as keyof PendingItemWrap]!==expected[k as keyof PendingItemWrap]))return fail();
}
async function load(input:Input){
  const entry=await input.journal.read(input.signal);input.signal.throwIfAborted();if(!entry)return null;
  const draft=await parse(await decryptShareJournal(entry,input.tenant,input.pair,"group-item-wrap"),entry,input);
  input.signal.throwIfAborted();return {entry,draft};
}
export async function pendingItemWrap(input:Input){const held=await load(input);return held?pending(held.draft,held.entry):null;}
/** Persist exact opaque bytes before any remote write. A lost reply retains the
 * bundle; retries recheck authority without replacing its nonce or ciphertext. */
export async function applyItemWrap(input:Input&{bundle?:ItemWrapBundle;expected?:PendingItemWrap}){
  const bundle=input.bundle?await parseItemWrapBundle(input.bundle,input.principal):undefined,expected=structuredClone(input.expected);
  let held=await load(input);
  if(held){if(bundle)return fail();matches(held.draft,held.entry,expected);}
  else{
    if(!bundle)return fail();
    const draft=await parse({version:1,tenant:input.tenant,principal:input.principal,pub:input.pair.pub,epub:input.pair.epub,bundle},{object:bundle.object},input);
    const encrypted=await encryptShareJournal(draft,input.tenant,bundle.object,input.pair,"group-item-wrap");input.signal.throwIfAborted();
    const entry=await input.journal.write({...encrypted,tenant:input.tenant,object:bundle.object},null,input.signal);held={entry,draft};
  }
  await createItemWrapClient(input.principal,input.fetcher,input.clock).publish(held.draft.bundle,input.signal);
  input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);return {delivered:true as const};
}

/** Retire only the local draft after current owner authority proves a newer
 * epoch. Published history and ciphertext are untouched; uncertain reads retain it. */
export async function retireItemWrap(input:Input&{expected:PendingItemWrap}){
  const expected=structuredClone(input.expected),held=await load(input);if(!held)return fail();
  matches(held.draft,held.entry,expected);
  await createItemWrapClient(input.principal,input.fetcher,input.clock).confirmObsolete(held.draft.bundle,input.signal);
  input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);return {retired:true as const};
}
