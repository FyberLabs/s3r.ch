import {lengthPrefixed} from "sociacl-ids";
import type {SeaPair} from "./identity/sea";
import {parseForumAuthority} from "./identity/forum-authority-records";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
import {createGroupCommandClient,parseSignedGroupCommand,type GroupSignedCommand} from "./media-group-client";
import {encryptShareJournal,decryptShareJournal,type ShareJournal,type ShareEntry} from "./media-share-journal";

type Draft={version:1;tenant:string;principal:string;pub:string;epub:string;command:GroupSignedCommand;attemptAt:number|null};
export type PendingGroupCommand=Readonly<{kind:"create"|"member";set:string;principal:string;token:string}>;
type Input={tenant:string;principal:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;clock?:()=>number};
const fail=():never=>{throw Error("Saved group command unavailable");};
function parse(value:unknown,entry:Pick<ShareEntry,"object">,input:Pick<Input,"tenant"|"principal"|"pair">):Draft {
  const d=value as Draft,{tenant,principal,pair}=input;
  if(!d||d.version!==1||d.tenant!==tenant||d.principal!==principal||d.pub!==pair.pub||d.epub!==pair.epub||
      (d.attemptAt!==null&&(!Number.isSafeInteger(d.attemptAt)||d.attemptAt<0)))return fail();
  const command=parseSignedGroupCommand(d.command,principal);
  if(command.body.set!==entry.object)return fail();
  if(command.kind==="member") {
    const row=command.body.row as {record:{sig:string}},signed=parseForumAuthority("membership",row.record);
    if(!signed||!verifyForumKeySignature(pair.pub,row.record.sig,signed.bytes))return fail();
  } else {
    const c=command.body.config as Record<string,string|number>;
    const bytes=lengthPrefixed(["s3rch-group-epoch-config-v1",String(c.owner),String(c.setId),String(c.predicate),String(c.settleWindowMs),String(c.configRevision)]);
    const raw=Uint8Array.from(String(c.signature).match(/../g)!,value=>parseInt(value,16));
    const signature=btoa(String.fromCharCode(...raw)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    if(!bytes.ok||!verifyForumKeySignature(pair.pub,signature,bytes.value))return fail();
  }
  return {...d,command};
}
const pending=(draft:Draft,entry:ShareEntry):PendingGroupCommand=>({kind:draft.command.kind,set:entry.object,principal:draft.principal,token:entry.sha256});
function matches(draft:Draft,entry:ShareEntry,expected:PendingGroupCommand) {
  const actual=pending(draft,entry);
  if(!expected||expected.kind!==actual.kind||expected.set!==actual.set||expected.principal!==actual.principal||expected.token!==actual.token)return fail();
}
async function load(input:Input) {
  const entry=await input.journal.read(input.signal);input.signal.throwIfAborted();
  if(!entry)return null;
  const draft=parse(await decryptShareJournal(entry,input.tenant,input.pair,"group-command"),entry,input);
  input.signal.throwIfAborted();return {draft,entry};
}
async function save(input:Input,draft:Draft,expected:number|null) {
  const set=draft.command.body.set as string;
  draft=parse(draft,{object:set},input);
  const encrypted=await encryptShareJournal(draft,input.tenant,set,input.pair,"group-command");input.signal.throwIfAborted();
  const entry=await input.journal.write({...encrypted,tenant:input.tenant,object:set},expected,input.signal);
  return {draft:parse(draft,entry,input),entry};
}
export async function pendingGroupCommand(input:Input) {
  const held=await load(input);return held?pending(held.draft,held.entry):null;
}
/** Persist signature before transmission and persist the attempted fence time before each write. */
export async function applyGroupCommand(input:Input&{command?:GroupSignedCommand;expected?:PendingGroupCommand}) {
  const command=input.command?parseSignedGroupCommand(input.command,input.principal):undefined;
  const expected=input.expected?structuredClone(input.expected):undefined;
  let held=await load(input);
  if(held){if(command)return fail();matches(held.draft,held.entry,expected!);}
  else {
    if(!command)return fail();
    held=await save(input,{version:1,tenant:input.tenant,principal:input.principal,pub:input.pair.pub,epub:input.pair.epub,command,attemptAt:null},null);
  }
  const client=createGroupCommandClient(input.principal,input.fetcher,input.clock);
  await client.apply(held.draft.command,input.signal,async at=>{
    held=await save(input,{...held!.draft,attemptAt:at},held!.entry.revision);
  });
  input.signal.throwIfAborted();await input.journal.remove(held.entry.revision,input.signal);
}
export async function discardGroupCommand(input:Input&{expected:PendingGroupCommand}) {
  const expected=structuredClone(input.expected),held=await load(input);
  if(!held)return fail();matches(held.draft,held.entry,expected);
  const state=await createGroupCommandClient(input.principal,input.fetcher,input.clock).state(held.draft.command,input.signal);
  if(state.state!=="applied"&&held.draft.attemptAt!==null&&state.at-held.draft.attemptAt<=4)return fail();
  input.signal.throwIfAborted();await input.journal.remove(held.entry.revision,input.signal);
  return {applied:state.state==="applied"};
}
