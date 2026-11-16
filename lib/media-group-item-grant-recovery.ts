import type {SeaPair} from "./identity/sea";
import {createItemGrantClient,parseSignedItemGrant,type SignedItemGrant} from "./media-group-item-grant-client";
import {encryptShareJournal,decryptShareJournal,type ShareJournal,type ShareEntry} from "./media-share-journal";
import type {ItemGrantPayload} from "./media-group-item-grant";
type Input={tenant:string;principal:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;clock?:()=>number};
type Draft={version:1;tenant:string;principal:string;pub:string;epub:string;command:SignedItemGrant};
export type PendingItemGrant={object:string;predicate:string;set:string;reader:string;withdraw:boolean;token:string};
const fail=():never=>{throw Error("Saved group item grant unavailable");};
function parse(value:unknown,entry:Pick<ShareEntry,"object">,input:Input):Draft {
  const d=value as Draft;
  if(!d||d.version!==1||d.tenant!==input.tenant||d.principal!==input.principal||d.pub!==input.pair.pub||d.epub!==input.pair.epub)return fail();
  const command=parseSignedItemGrant(d.command,input.principal);
  if(command.ownerPub!==input.pair.pub||command.body.object!==entry.object)return fail();
  return {...d,command};
}
function pending(draft:Draft,entry:ShareEntry):PendingItemGrant {
  const {object,predicate,set,payload}=draft.command.body,claims=(payload as ItemGrantPayload).claims;
  return {object:object as string,predicate:predicate as string,set:set as string,reader:claims.accessor,withdraw:claims.stated===0,token:entry.sha256};
}
function matches(draft:Draft,entry:ShareEntry,expected:PendingItemGrant) {
  const actual=pending(draft,entry);
  if(!expected||Object.keys(actual).some(k=>actual[k as keyof PendingItemGrant]!==expected[k as keyof PendingItemGrant]))return fail();
}
async function load(input:Input) {
  const entry=await input.journal.read(input.signal);input.signal.throwIfAborted();if(!entry)return null;
  const draft=parse(await decryptShareJournal(entry,input.tenant,input.pair,"group-item-grant"),entry,input);
  input.signal.throwIfAborted();return {entry,draft};
}
export async function pendingItemGrant(input:Input) {const held=await load(input);return held?pending(held.draft,held.entry):null;}
export async function applyItemGrant(input:Input&{command?:SignedItemGrant;expected?:PendingItemGrant}) {
  const command=input.command?parseSignedItemGrant(input.command,input.principal):undefined,expected=structuredClone(input.expected);
  let held=await load(input);
  if(held){if(command)return fail();matches(held.draft,held.entry,expected!);}
  else {
    if(!command)return fail();
    const object=command.body.object as string;
    const draft=parse({version:1,tenant:input.tenant,principal:input.principal,pub:input.pair.pub,epub:input.pair.epub,command},{object},input);
    const encrypted=await encryptShareJournal(draft,input.tenant,object,input.pair,"group-item-grant");input.signal.throwIfAborted();
    const entry=await input.journal.write({...encrypted,tenant:input.tenant,object},null,input.signal);held={draft,entry};
  }
  const result=await createItemGrantClient(input.principal,input.fetcher,input.clock).apply(held.draft.command,input.signal);
  input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);return result;
}
export async function discardItemGrant(input:Input&{expected:PendingItemGrant}) {
  const expected=structuredClone(input.expected),held=await load(input);if(!held)return fail();matches(held.draft,held.entry,expected);
  const state=await createItemGrantClient(input.principal,input.fetcher,input.clock).state(held.draft.command,input.signal);
  if(state.state!=="applied"&&!state.frozen&&state.at-(held.draft.command.body.at as number)<=4)return fail();
  input.signal.throwIfAborted();await input.journal.remove(held.entry,input.signal);return state;
}
