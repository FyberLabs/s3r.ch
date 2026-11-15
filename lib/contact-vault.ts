import {parsePrincipalId,resolveCurrentKey,linkId,type UnsignedRecord} from 'sociacl-ids';
import type {Descriptor,Row} from 'sociacl-ids/first-contact-store';
import {parseFirstContactRequest,type VerifiedFirstContact,type FirstContactRequest} from 'sociacl-ids/first-contact';
import type {SeaPair} from './identity/sea';
import {contactHistory} from './contact-history';
import {openContactDocuments} from './contact-document-client';
import {contactBytes,contactBase64} from './contact-document-client';
import {contactVaultKey,openContactVault,sealContactVault} from './contact-crypto';
import {contactText,type ContactMessageView} from './contact-inbox-view';
export type SavedRequest=Omit<Row,'envelope'> & {envelope:string;verified?:VerifiedFirstContact};
export type SavedPeer={principal:string;blocked:boolean;grant?:string};
export type SavedSend={id:string;peer:string;lane:string;ciphertext:string;kind:'text'|'grant'|'request';body?:string;replayKey?:string;requestId?:string;grant?:string};
export type ContactVault={v:1;owner:string;keyring:{rotationSeq:number;baseLaneIds:string[];contactSecrets:string[]};
  journal:{revision:number;clock:number;enabled:boolean;descriptor:Descriptor|null;rows:SavedRequest[]};
  contacts:SavedPeer[];messages:(ContactMessageView & {peer:string})[];seen:{id:string;expiresAt:number}[];outbox:SavedSend[];sent:{peer:string;request:FirstContactRequest;requestId:string;replyLane:string}[]};
const fail=():never=>{throw Error('Contact vault unavailable');};
const hex=/^[0-9a-f]{64}$/;
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const grant=(v:unknown):v is string=>typeof v==='string'&&/^(?:[0-9a-f]{2}){94,4096}$/.test(v);
const principal=(v:unknown)=>typeof v==='string'&&parsePrincipalId(v).ok;
export function parseContactVault(input:unknown,owner:string):ContactVault{
  const v=structuredClone(input) as ContactVault;
  if(!v||v.v!==1||v.owner!==owner||!v.keyring||!Number.isSafeInteger(v.keyring.rotationSeq)||v.keyring.rotationSeq<0||v.keyring.rotationSeq>1024||
    !Array.isArray(v.keyring.baseLaneIds)||!Array.isArray(v.keyring.contactSecrets)||v.keyring.baseLaneIds.length!==v.keyring.rotationSeq+1||v.keyring.contactSecrets.length!==v.keyring.rotationSeq+1||
    [...v.keyring.baseLaneIds,...v.keyring.contactSecrets].some(s=>typeof s!=='string'||!hex.test(s))||
    new Set([...v.keyring.baseLaneIds,...v.keyring.contactSecrets]).size!==2*(v.keyring.rotationSeq+1))return fail();
  if(!v.journal||!Number.isSafeInteger(v.journal.revision)||v.journal.revision<0||!Number.isSafeInteger(v.journal.clock)||v.journal.clock<0||typeof v.journal.enabled!=='boolean'||
    !Array.isArray(v.journal.rows)||v.journal.rows.length>256||!Array.isArray(v.contacts)||v.contacts.length>64||!Array.isArray(v.messages)||v.messages.length>128||
    !Array.isArray(v.seen)||v.seen.length>512||!Array.isArray(v.outbox)||v.outbox.length>32||!Array.isArray(v.sent)||v.sent.length>32)return fail();
  if(new Set(v.contacts.map(p=>p.principal)).size!==v.contacts.length||v.contacts.some(p=>!parsePrincipalId(p.principal).ok||typeof p.blocked!=='boolean'||(p.grant!==undefined&&!/^(?:[0-9a-f]{2}){94,4096}$/.test(p.grant))))return fail();
  const d=v.journal.descriptor;
  if(d!==null&&(!d||!hex.test(d.channelId)||!integer(d.revision)||d.revision<1||d.revision!==v.journal.revision||!principal(d.encryptionEpub)||!integer(d.expiresAt)||
    !integer(d.maxLifetimeSeconds)||d.maxLifetimeSeconds<1||d.maxLifetimeSeconds>604800||!integer(d.maxMessageBytes)||d.maxMessageBytes<1||d.maxMessageBytes>4096))return fail();
  if(v.journal.enabled&&!d)return fail();
  if(new Set(v.journal.rows.map(r=>r.replayKey)).size!==v.journal.rows.length)return fail();
  for(const row of v.journal.rows){
    if(!hex.test(row.replayKey)||!hex.test(row.requestId)||!Number.isSafeInteger(row.replayUntil)||!Number.isSafeInteger(row.expiresAt)||
      !Number.isSafeInteger(row.revision)||!['pending','accepted','rejected','delivered'].includes(row.status))return fail();
    if(row.revision<1||row.expiresAt<0||row.replayUntil<row.expiresAt||row.revision>v.journal.revision)return fail();
    if(row.status==='accepted'&&(!row.verified||!row.grant))return fail();
    if(row.grant&&(!grant(row.grant.ciphertextHex)||!integer(row.grant.rotationSeq)))return fail();
    if(row.verified&&(!parseFirstContactRequest(row.verified.request).ok||row.verified.requestId!==row.requestId||row.verified.replayKey!==row.replayKey||row.verified.replayUntil!==row.replayUntil))return fail();
    const bytes=contactBytes(row.envelope);if(bytes.length<94||bytes.length>8192)return fail();
  }
  for(const collection of [v.messages,v.seen,v.outbox])if(new Set(collection.map(r=>r.id)).size!==collection.length)return fail();
  for(const row of v.messages)if(!hex.test(row.id)||!principal(row.sender)||!principal(row.peer)||(row.sender!==owner&&row.sender!==row.peer)||typeof row.body!=='string'||contactText(row.body)!==row.body)return fail();
  for(const row of v.seen)if(!hex.test(row.id)||!integer(row.expiresAt))return fail();
  for(const row of v.outbox){
    const size=contactBytes(row.ciphertext).length;
    if(!hex.test(row.id)||!hex.test(row.lane)||!principal(row.peer)||!['text','grant','request'].includes(row.kind)||size<94||size>16384)return fail();
    if(row.kind==='request'){if(!row.requestId||!hex.test(row.requestId)||size>8192)return fail();}
    else if(!grant(row.grant)||typeof row.body!=='string'||(row.kind==='text'?contactText(row.body)!==row.body:!grant(row.body)))return fail();
  }
  if(new Set(v.sent.map(r=>r.requestId)).size!==v.sent.length)return fail();
  for(const row of v.sent)if(!principal(row.peer)||!hex.test(row.replyLane)||!hex.test(row.requestId)||!parseFirstContactRequest(row.request).ok||row.request.sender!==owner)return fail();
  return v;
}
export type ContactDocuments=Awaited<ReturnType<typeof openContactDocuments>>;
export async function createContactVault(documents:ContactDocuments,pair:SeaPair,current:()=>boolean,clock=()=>Math.floor(Date.now()/1000)){
  const config=documents.configuration,owner=config.principal,held={...pair},key=await contactVaultKey(held,owner);
  let authority:ReturnType<typeof contactHistory>|undefined,at=-1;
  let history:Awaited<ReturnType<ContactDocuments['read']>>['head']['history']|undefined;
  function guard(signal:AbortSignal){signal.throwIfAborted();if(!current())return fail();}
  function state(principal:string){
    if(!current()||!authority||clock()!==at)return fail();
    const parsed=parsePrincipalId(principal);if(!parsed.ok)return fail();const account=authority.accounts.get(parsed.value);if(!account)return fail();
    return {rotations:account.rotations,context:authority.contextFor(parsed.value,at)};
  }
  function bind(doc:Awaited<ReturnType<ContactDocuments['read']>>){
    if(doc.at<at||doc.head.currentKey!==held.pub)return fail();
    history=doc.head.history;authority=contactHistory(doc.head.history,{...config.trust,pinnedIss:new Set(config.trust.pinnedIss)},doc.at);at=doc.at;
    const own=state(owner),parsed=parsePrincipalId(owner);if(!parsed.ok)return fail();
    const resolved=resolveCurrentKey(parsed.value,own.rotations,own.context);
    if(!resolved.ok||resolved.value.currentKey!==held.pub||resolved.value.currentEpub!==held.epub)return fail();
  }
  async function load(signal:AbortSignal){
    guard(signal);const doc=await documents.read(owner,'vault',signal);guard(signal);bind(doc);
    const value=doc.payload===null?null:parseContactVault(await openContactVault(key,owner,doc.payload),owner);guard(signal);
    if(value&&value.keyring.rotationSeq!==doc.head.sequence)return fail();
    return {doc,value};
  }
  async function commit(value:ContactVault,revision:number,fence:string,signal:AbortSignal,validate=()=>{}){
    guard(signal);const snapshot=parseContactVault(value,owner);validate();
    const bytes=await sealContactVault(key,owner,snapshot);guard(signal);validate();
    const prepared=await documents.prepare('vault',revision,bytes,signal,fence);guard(signal);validate();
    const saved=await prepared.submit(signal);guard(signal);validate();return saved;
  }
  async function change<T>(work:(value:ContactVault,now:number)=>T,signal:AbortSignal,validate=()=>{}){
    const {doc,value}=await load(signal);if(!value)return fail();const now=clock();if(now<value.journal.clock)return fail();value.journal.clock=now;
    value.journal.rows=value.journal.rows.filter(r=>r.replayUntil>now||r.status==='accepted');
    const result=work(value,now);await commit(value,doc.revision,doc.fence,signal,validate);return result;
  }
  return {owner,pair:held,current,load,change,state,guard,
    allState(){
      const own=state(owner);if(!history)return fail();
      const links=new Map(history.links.map(raw=>{const id=linkId(raw as UnsignedRecord);if(!id.ok)return fail();return [id.value,raw] as const;}));
      return {rotations:history.accounts.flatMap(a=>a.rotations),context:{...own.context,links,
        genesisEpubBindings:history.accounts.flatMap(a=>a.genesisEpubBindings),revocations:history.accounts.flatMap(a=>a.revocations)}};
    },
    peer(principal:string){const parsed=parsePrincipalId(principal);if(!parsed.ok)return fail();const s=state(principal),resolved=resolveCurrentKey(parsed.value,s.rotations,s.context);
      if(!resolved.ok||!resolved.value.currentEpub)return fail();return {principal,pub:resolved.value.currentKey,epub:resolved.value.currentEpub};},
    issuer(value:ContactVault){return {...state(owner),issuer:{principal:owner,signingPriv:held.priv,rotationSeq:value.keyring.rotationSeq,
      baseLaneIds:[...value.keyring.baseLaneIds],contactSecrets:[...value.keyring.contactSecrets],contactSecretHex:value.keyring.contactSecrets.at(-1)!}};},
    async restore(input:unknown,signal:AbortSignal){
      const {doc,value}=await load(signal);if(value||doc.revision!==0)return fail();
      const k=input as Record<string,unknown>;
      if(!k||k.principal!==owner||k.pub!==held.pub||k.epub!==held.epub||k.rotationSeq!==doc.head.sequence||!Array.isArray(k.priorLanes)||!Array.isArray(k.priorContactSecrets))return fail();
      const restored=parseContactVault({v:1,owner,keyring:{rotationSeq:k.rotationSeq,baseLaneIds:[...k.priorLanes,k.laneId],contactSecrets:[...k.priorContactSecrets,k.contactLaneSecret]},
        journal:{revision:0,clock:clock(),enabled:false,descriptor:null,rows:[]},contacts:[],messages:[],seen:[],outbox:[],sent:[]},owner);
      await commit(restored,0,doc.fence,signal);
    },
  };
}
export type ContactVaultStore=Awaited<ReturnType<typeof createContactVault>>;
