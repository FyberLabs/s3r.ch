import type {SeaPair} from "./identity/sea";
import {parseForumAuthority} from "./identity/forum-authority-records";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
import {createMediaGroupMember,parseMemberGroupRow} from "./media-group-member";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {decryptShareJournal,encryptShareJournal,type ShareEntry,type ShareJournal} from "./media-share-journal";

type Row=ReturnType<typeof parseMemberGroupRow>;
type Draft={version:1;tenant:string;object:string;scope:MediaGroupScope;member:string;memberPub:string;epub:string;row:Row};
export type PendingGroupConsent=Readonly<{object:string;member:string;scope:MediaGroupScope;stated:0|1;token:string}>;
type Input={tenant:string;pair:SeaPair;fetcher:typeof fetch;signal:AbortSignal;journal:ShareJournal;clock?:()=>number};
function parse(value:unknown,entry:ShareEntry,tenant:string,pair:SeaPair):Draft {
  const d=value as Draft;
  if(!d||d.version!==1||d.tenant!==tenant||d.object!==entry.object||d.memberPub!==pair.pub||d.epub!==pair.epub)
    throw Error("Consent recovery identity changed");
  const scope=parseMediaGroupScope(d.scope),row=parseMemberGroupRow(d.row,scope,d.member);
  const signed=parseForumAuthority("membership",row.record);
  if(!signed||!verifyForumKeySignature(pair.pub,row.record.sig,signed.bytes))throw Error("Consent recovery signature refused");
  return {...d,scope,row};
}
const pending=(d:Draft,entry:ShareEntry):PendingGroupConsent=>({object:d.object,member:d.member,scope:d.scope,stated:d.row.record.stated,token:entry.sha256});
function match(d:Draft,entry:ShareEntry,expected:PendingGroupConsent) {
  const held=pending(d,entry);
  if(!expected||expected.object!==held.object||expected.member!==held.member||expected.stated!==held.stated||expected.token!==held.token||
    expected.scope?.predicate!==held.scope.predicate||expected.scope?.set!==held.scope.set)throw Error("Saved consent changed; inspect it again");
}
async function load(journal:ShareJournal,tenant:string,pair:SeaPair,signal:AbortSignal) {
  const entry=await journal.read(signal);signal.throwIfAborted();if(!entry)return null;
  const draft=parse(await decryptShareJournal(entry,tenant,pair,"group-consent"),entry,tenant,pair);
  signal.throwIfAborted();return {entry,draft};
}
export async function pendingGroupConsent(journal:ShareJournal,tenant:string,pair:SeaPair,signal:AbortSignal) {
  const held=await load(journal,tenant,pair,signal);return held?pending(held.draft,held.entry):null;
}
/** Persist signatures before sending. Resume only reconciles the exact saved row. */
export async function applyGroupConsent(input:Input&{target?:{object:string;scope:MediaGroupScope;member:string;stated:0|1};expected?:PendingGroupConsent}) {
  const {tenant,pair,fetcher,signal,journal}=input,client=createMediaGroupMember(fetcher,input.clock);
  // Detach UI input before asynchronous storage or protected-source reads.
  const target=input.target?structuredClone(input.target):undefined,expected=input.expected?structuredClone(input.expected):undefined;
  let saved=await load(journal,tenant,pair,signal);
  if(saved){if(target)throw Error("Resume saved consent first");match(saved.draft,saved.entry,expected!);}
  else {
    if(!target)throw Error("No saved consent");
    if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid consent signing key");
    const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
    try {
      if(scalar.length!==32||btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)throw Error("Invalid consent signing key");
      const scope=parseMediaGroupScope(target.scope);
      const row=await client.prepare(target.object,scope,target.member,target.stated,scalar,signal);
      const draft:Draft={version:1,tenant,object:target.object,scope,member:target.member,memberPub:pair.pub,epub:pair.epub,row};
      const encrypted=await encryptShareJournal(draft,tenant,target.object,pair,"group-consent");signal.throwIfAborted();
      const entry=await journal.write({...encrypted,tenant,object:target.object},null,signal);
      saved={entry,draft:parse(draft,entry,tenant,pair)};
    } finally {scalar.fill(0);}
  }
  const {draft,entry}=saved;
  await client.append(draft.object,draft.scope,draft.member,draft.row,signal);
  signal.throwIfAborted();await journal.remove(entry.revision,signal);
  return {object:draft.object,stated:draft.row.record.stated};
}
/** An absent row can be discarded only after the server's application window. */
export async function discardGroupConsent(input:Input&{expected:PendingGroupConsent}) {
  const expected=structuredClone(input.expected),held=await load(input.journal,input.tenant,input.pair,input.signal);
  if(!held)return;
  const {draft,entry}=held;match(draft,entry,expected);
  const state=await createMediaGroupMember(input.fetcher,input.clock).state(draft.object,draft.scope,draft.member,draft.row,input.signal);
  if(state.state!=="applied"&&state.at-draft.row.record.issuedAt<=4)throw Error("Consent may still apply; retry recovery after its signing window");
  input.signal.throwIfAborted();await input.journal.remove(entry.revision,input.signal);
  return {applied:state.state==="applied"};
}
