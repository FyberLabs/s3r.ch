import {lengthPrefixed,parsePrincipalId,signWithKeyring} from 'sociacl-ids';
import {firstContactRequestBytes,firstContactDescriptorBytes,verifyFirstContactDescriptor,verifyFirstContactRequest,
 sealFirstContactRequest,pollFirstContact,restorePendingFirstContacts,acceptFirstContactRequest,type VerifiedFirstContact,type SignedFirstContactDescriptor} from 'sociacl-ids/first-contact';
import {deriveContactLane,openContactLaneGrant,sealContactLaneGrant} from 'sociacl-ids/contact-lane';
import type {SeaPair} from './identity/sea';
import {contactText,type ContactInboxSession} from './contact-inbox-view';
import {openContactDocuments,contactBytes,contactBase64,contactDigest} from './contact-document-client';
import {createContactVault,type ContactVault,type SavedSend} from './contact-vault';
import {contactJournal,activateContactJournal} from './contact-journal';
import {createContactLaneTransport,createFirstContactTransport} from './contact-lane-transport';
import {sealContactMessage,openContactMessage,type ContactPeer} from './contact-crypto';
const fail=():never=>{throw Error('Contacts unavailable');};
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const fromHex=(value:string)=>{if(!/^(?:[0-9a-f]{2})+$/.test(value))return fail();return Uint8Array.from(value.match(/../g)!,b=>parseInt(b,16));};
const toHex=(value:Uint8Array)=>Array.from(value,b=>b.toString(16).padStart(2,'0')).join('');
const equal=(a:ContactPeer,b:ContactPeer)=>a.principal===b.principal&&a.pub===b.pub&&a.epub===b.epub;
async function replyLane(owner:string,request:VerifiedFirstContact){const bytes=lengthPrefixed(['s3rch-contact-reply-v1',owner,request.request.sender,request.request.nonce,request.requestId]);if(!bytes.ok)return fail();return contactDigest(bytes.value);}
export async function openContactWorkspace(options:{pair:SeaPair;current:()=>boolean;subscribe:(listener:()=>void)=>()=>void;origin:string;signal:AbortSignal;fetcher?:typeof fetch;clock?:()=>number}){
 const {pair,current,subscribe,origin,signal}=options,fetcher=options.fetcher??fetch,clock=options.clock??(()=>Math.floor(Date.now()/1000));
 const documents=await openContactDocuments(pair,current,signal,fetcher,clock),vault=await createContactVault(documents,pair,current,clock),owner=vault.owner;
 const transport=createContactLaneTransport(origin,fetcher),requests=createFirstContactTransport(origin,fetcher);
 const initial=await vault.load(signal);let ready=initial.value!==null;
 function required(v:ContactVault|null){if(!v)return fail();return v;}
 function allowed(v:ContactVault,peer:string){const p=v.contacts.find(p=>p.principal===peer);if(!p||p.blocked)return fail();return p;}
 function sign(bytes:Uint8Array){const who=parsePrincipalId(pair.pub);if(!who.ok)return fail();const key=Uint8Array.from(atob(pair.priv.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));try{const result=signWithKeyring(key,bytes,who.value);if(!result.ok)return fail();return result.value;}finally{key.fill(0);}}
 async function fresh(signal:AbortSignal){const {value}=await vault.load(signal);return required(value);}
 async function receivedGrant(v:ContactVault,peer:string){const contact=allowed(v,peer);if(!contact.grant)return fail();return openContactLaneGrant(owner,pair.epriv,{ciphertextHex:contact.grant},peer,()=>vault.state(peer));}
 async function dispatch(id:string,signal:AbortSignal){
  const v=await fresh(signal),entry=v.outbox.find(r=>r.id===id);if(!entry)return;vault.guard(signal);
  if(entry.kind==='request'){
   if(v.contacts.find(p=>p.principal===entry.peer)?.blocked)return fail();
   const sent=v.sent.find(s=>s.requestId===entry.requestId);if(!sent||sent.request.expiresAt<=clock())return fail();
   const doc=await documents.read(entry.peer,'descriptor',signal);const latest=await fresh(signal);
   if(latest.contacts.find(p=>p.principal===entry.peer)?.blocked)return fail();
   if(!doc.payload)return fail();const ad=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contactBytes(doc.payload))).advertisement;
   const target=parsePrincipalId(entry.peer);if(!target.ok)return fail();const state=vault.state(entry.peer);
   const checked=verifyFirstContactDescriptor(ad,target.value,doc.revision,state.rotations,state.context);
   if(!checked.ok||checked.value.descriptor.channelId!==entry.lane||checked.value.descriptor.revision!==sent.request.descriptorRevision)return fail();
   const own=vault.state(owner);if(!verifyFirstContactRequest(sent.request,own.rotations,own.context,checked.value.descriptor).ok)return fail();
   await requests.append(entry.lane,contactBytes(entry.ciphertext),signal);
  }else{
   const active=allowed(v,entry.peer);if(active.grant!==entry.grant)return fail();
   const grant=await receivedGrant(v,entry.peer);
   if(grant.laneId!==entry.lane)return fail();
   await transport.append(entry.lane,contactBytes(entry.ciphertext),signal);
  }
  vault.guard(signal);await vault.change(next=>{if(entry.kind!=='request')allowed(next,entry.peer);next.outbox=next.outbox.filter(r=>r.id!==id);if(entry.kind==='grant'){next.sent=next.sent.filter(s=>s.peer!==entry.peer);next.outbox=next.outbox.filter(r=>r.kind!=='request'||r.peer!==entry.peer);}},signal);
 }
 async function queue(peer:string,kind:'text'|'grant',body:string,signal:AbortSignal){
  const v=await fresh(signal);allowed(v,peer);
  const existing=v.outbox.find(r=>r.peer===peer&&r.kind===kind&&r.body===body);if(existing)return {submit:(signal:AbortSignal)=>dispatch(existing.id,signal)};
  const grant=await receivedGrant(v,peer),sender=vault.peer(owner),recipient=vault.peer(peer),id=random();
  const bytes=await sealContactMessage(grant.laneId,pair,()=>vault.peer(owner),()=>vault.peer(peer),{v:1,id,kind,body,issuedAt:clock(),expiresAt:clock()+604800},clock);
  const entry:SavedSend={id,peer,lane:grant.laneId,ciphertext:contactBase64(bytes),kind,body,grant:v.contacts.find(p=>p.principal===peer)!.grant};
  await vault.change(next=>{const active=allowed(next,peer);if(active.grant!==entry.grant||!equal(sender,vault.peer(owner))||!equal(recipient,vault.peer(peer)))return fail();if(next.outbox.length>=32)return fail();next.outbox.push(entry);
   if(kind==='text'){next.messages.push({id,sender:owner,peer,body});next.messages=next.messages.slice(-128);}},signal);
  return {submit:(signal:AbortSignal)=>dispatch(id,signal)};
 }
 async function deliverAcceptances(signal:AbortSignal){
  let v=await fresh(signal);
  for(const row of v.journal.rows.filter(r=>r.status==='accepted')){
   if(!row.verified||!row.grant)return fail();const peer=row.verified.request.sender;
   if(v.contacts.find(p=>p.principal===peer)?.blocked)continue;
   const state=vault.peer(peer);if(state.epub!==row.verified.request.replyEpub||row.grant.rotationSeq!==v.keyring.rotationSeq)return fail();
   const lane=await replyLane(owner,row.verified);v=await fresh(signal);
   const retained=v.journal.rows.find(r=>r.requestId===row.requestId);
   if(!retained||retained.status!=='accepted'||retained.grant?.ciphertextHex!==row.grant.ciphertextHex||v.contacts.find(p=>p.principal===peer)?.blocked)return fail();
   if(vault.peer(peer).epub!==row.verified.request.replyEpub||row.grant.rotationSeq!==v.keyring.rotationSeq)return fail();vault.guard(signal);
   await transport.append(lane,fromHex(row.grant.ciphertextHex),signal);
   const journal=contactJournal(vault,signal);try{await journal.acknowledge(row.replayKey,row.requestId,row.grant.ciphertextHex);}finally{journal.close();}
   v=await fresh(signal);
  }
 }
 async function receiveAcceptances(signal:AbortSignal){
  const v=await fresh(signal);
  for(const sent of v.sent){
   if(v.contacts.find(p=>p.principal===sent.peer)?.blocked)continue;
   for(const row of await transport.read(sent.replyLane,signal)){
    await fresh(signal);let opened;
    try{opened=await openContactLaneGrant(owner,pair.epriv,{ciphertextHex:toHex(row.ciphertext)},sent.peer,()=>vault.state(sent.peer));}catch{continue;}
    if(!opened)continue;const peer=vault.peer(sent.peer),mine=vault.peer(owner);
    await vault.change(next=>{if(next.contacts.find(p=>p.principal===sent.peer)?.blocked||!equal(peer,vault.peer(sent.peer))||!equal(mine,vault.peer(owner)))return fail();
      let contact=next.contacts.find(p=>p.principal===sent.peer);if(!contact){if(next.contacts.length>=64)return fail();contact={principal:sent.peer,blocked:false};next.contacts.push(contact);}contact.grant=toHex(row.ciphertext);},signal);
    const latest=await fresh(signal),pendingGrant=latest.outbox.find(r=>r.peer===sent.peer&&r.kind==='grant');
    if(pendingGrant){await dispatch(pendingGrant.id,signal);break;}
    const reciprocal=await sealContactLaneGrant(sent.peer,()=>vault.state(sent.peer),()=>vault.issuer(latest));
    const prepared=await queue(sent.peer,'grant',reciprocal.ciphertextHex,signal);await prepared.submit(signal);
    await vault.change(next=>{next.sent=next.sent.filter(s=>s.requestId!==sent.requestId);},signal);break;
   }
  }
 }
 async function receiveMessages(peer:string,signal:AbortSignal){
  const initial=await fresh(signal);allowed(initial,peer);
  const lane=deriveContactLane(initial.keyring.contactSecrets.at(-1)!,owner,peer);
  for(const row of await transport.read(lane,signal)){
   const v=await fresh(signal);allowed(v,peer);const sender=vault.peer(peer),recipient=vault.peer(owner);let content;
   try{content=await openContactMessage(lane,pair,()=>vault.peer(peer),()=>vault.peer(owner),row.ciphertext,clock);}catch{continue;}
   const seen=await contactDigest(new TextEncoder().encode(peer+':'+content.id));
   if(v.seen.some(s=>s.id===seen))continue;
   if(content.kind==='grant'){
    try{await openContactLaneGrant(owner,pair.epriv,{ciphertextHex:content.body},peer,()=>vault.state(peer));}catch{continue;}
   }
   await vault.change(next=>{const p=allowed(next,peer);if(!equal(sender,vault.peer(peer))||!equal(recipient,vault.peer(owner))||content.expiresAt<=clock())return fail();
    next.seen=next.seen.filter(s=>s.expiresAt>clock());if(next.seen.some(s=>s.id===seen))return;if(next.seen.length>=512)return fail();next.seen.push({id:seen,expiresAt:content.expiresAt});
    if(content.kind==='grant')p.grant=content.body;else{next.messages.push({id:seen,sender:peer,peer,body:content.body});next.messages=next.messages.slice(-128);}
   },signal);
  }
 }
 async function pending(signal:AbortSignal){
  const v=await fresh(signal);if(!v.journal.enabled||!v.journal.descriptor||v.journal.descriptor.expiresAt<=clock())return [];
  const journal=contactJournal(vault,signal);
  try{await pollFirstContact(journal,requests.read,pair.epriv,()=>vault.allState());return await restorePendingFirstContacts(journal,pair.epriv,()=>vault.allState());}finally{journal.close();}
 }
 const session:ContactInboxSession={id:random(),principal:owner,current,subscribe,
  async load(signal){await fresh(signal);await deliverAcceptances(signal);await receiveAcceptances(signal);
   const rows=await pending(signal),v=await fresh(signal);
   for(const entry of v.outbox){try{await dispatch(entry.id,signal);}catch{vault.guard(signal);}}
   const latest=await fresh(signal);return {requests:rows.filter(r=>!latest.contacts.find(p=>p.principal===r.request.sender)?.blocked).map(r=>({id:r.requestId,sender:r.request.sender,message:r.request.message})),contacts:latest.contacts.map(p=>({principal:p.principal,blocked:p.blocked}))};},
  async accept(id,signal){
   const rows=await pending(signal),selected=rows.find(r=>r.requestId===id);if(!selected)return fail();const v=await fresh(signal),journal=contactJournal(vault,signal,selected);
   try{await acceptFirstContactRequest(journal,selected.replayKey,id,pair.epriv,()=>vault.state(selected.request.sender),()=>vault.issuer(v));}finally{journal.close();}
   await deliverAcceptances(signal);
  },
  async reject(id,signal){const selected=(await pending(signal)).find(r=>r.requestId===id);if(!selected)return fail();const journal=contactJournal(vault,signal);
   try{await journal.decide(await journal.descriptor(),selected.replayKey,id,{status:'rejected'});}finally{journal.close();}},
  async block(peer,signal){await vault.change(v=>{const p=v.contacts.find(p=>p.principal===peer);if(!p)return fail();p.blocked=true;delete p.grant;v.outbox=v.outbox.filter(r=>r.peer!==peer);v.sent=v.sent.filter(r=>r.peer!==peer);
   for(const row of v.journal.rows)if(row.verified?.request.sender===peer&&row.status==='accepted'){row.status='rejected';delete row.grant;}},signal);},
  async messages(peer,signal){await receiveMessages(peer,signal);const v=await fresh(signal);allowed(v,peer);return v.messages.filter(m=>m.peer===peer).map(({id,sender,body})=>({id,sender,body}));},
  async prepareMessage(peer,text,signal){return queue(peer,'text',contactText(text),signal);},
 };
 return {session,get ready(){return ready;},
  async restore(input:unknown,signal:AbortSignal){await vault.restore(input,signal);ready=true;},
  async disableRequests(signal:AbortSignal){
   const journal=contactJournal(vault,signal);try{await journal.disable();}finally{journal.close();}
   const row=await documents.read(owner,'descriptor',signal);
   const prepared=await documents.prepare('descriptor',row.revision,new TextEncoder().encode(JSON.stringify({advertisement:null})),signal,row.fence);await prepared.submit(signal);
  },
  async enableRequests(signal:AbortSignal){
   const publicRow=await documents.read(owner,'descriptor',signal),v=await fresh(signal);let descriptor=v.journal.descriptor;
   if(publicRow.payload&&v.journal.enabled&&descriptor&&descriptor.expiresAt>clock()){
    const previous=JSON.parse(new TextDecoder().decode(contactBytes(publicRow.payload))).advertisement;
    if(previous&&JSON.stringify(previous.descriptor)===JSON.stringify(descriptor)&&publicRow.revision===descriptor.revision)return;
   }
   if(!descriptor||!v.journal.enabled||descriptor.expiresAt<=clock()||descriptor.revision!==publicRow.revision+1){
    descriptor=await activateContactJournal(vault,signal,{encryptionEpub:pair.epub,expiresAt:clock()+604800,maxLifetimeSeconds:300,maxMessageBytes:1024},publicRow.revision);
   }
   await fresh(signal);const principal=parsePrincipalId(owner);if(!principal.ok)return fail();
   const unsigned={v:1 as const,owner:principal.value,issuedAt:clock(),descriptor,sig:''};
   const ad:SignedFirstContactDescriptor={...unsigned,sig:sign(firstContactDescriptorBytes(unsigned))};
   const state=vault.state(owner);if(!verifyFirstContactDescriptor(ad,principal.value,descriptor.revision,state.rotations,state.context).ok)return fail();
   const prepared=await documents.prepare('descriptor',publicRow.revision,new TextEncoder().encode(JSON.stringify({advertisement:ad})),signal,publicRow.fence);await prepared.submit(signal);
  },
  async request(peer:string,text:string,signal:AbortSignal){
   const recipient=parsePrincipalId(peer),principal=parsePrincipalId(owner),epub=parsePrincipalId(pair.epub);if(!recipient.ok||!principal.ok||!epub.ok||peer===owner)return fail();
   const publicRow=await documents.read(peer,'descriptor',signal);let v=await fresh(signal);if(!publicRow.payload||v.contacts.find(p=>p.principal===peer)?.blocked)return fail();
   const pending=v.sent.find(s=>s.peer===peer&&s.request.message===contactText(text)&&s.request.expiresAt>clock());
   if(pending){if(v.outbox.some(r=>r.id===pending.requestId))await dispatch(pending.requestId,signal);return;}
   const ad=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(contactBytes(publicRow.payload))).advertisement,state=vault.state(peer);
   const checked=verifyFirstContactDescriptor(ad,recipient.value,publicRow.revision,state.rotations,state.context);if(!checked.ok)return fail();
   const request={v:1 as const,channelId:checked.value.descriptor.channelId,descriptorRevision:checked.value.descriptor.revision,sender:principal.value,replyEpub:epub.value,nonce:random(),issuedAt:clock(),expiresAt:Math.min(clock()+300,checked.value.descriptor.expiresAt),message:contactText(text),sig:''};
   request.sig=sign(firstContactRequestBytes(request));const own=vault.state(owner),verified=verifyFirstContactRequest(request,own.rotations,own.context,checked.value.descriptor);if(!verified.ok)return fail();
   const bytes=await sealFirstContactRequest(request,checked.value.descriptor),lane=await replyLane(peer,verified.value),id=verified.value.requestId;
   await vault.change(next=>{if(next.contacts.find(p=>p.principal===peer)?.blocked)return fail();next.sent=next.sent.filter(s=>s.request.expiresAt>clock());next.outbox=next.outbox.filter(r=>r.kind!=='request'||next.sent.some(s=>s.requestId===r.requestId));if(next.sent.length>=32||next.outbox.length>=32)return fail();
    next.sent.push({peer,request,requestId:id,replyLane:lane});next.outbox.push({id,peer,lane:request.channelId,ciphertext:contactBase64(bytes),kind:'request',requestId:id});},signal);
   await dispatch(id,signal);
  },
 };
}
