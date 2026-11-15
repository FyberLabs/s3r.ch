import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contactJournal,activateContactJournal} from './contact-journal';
import {parseContactVault,type ContactVault,type ContactVaultStore} from './contact-vault';
import type {VerifiedFirstContact} from 'sociacl-ids/first-contact';
import fixture from './identity/vectors/contact-acceptance.json';
const owner=fixture.mint.signingPub,peer=fixture.genesis.principal;
function setup(){
 let value:ContactVault={v:1,owner,keyring:{rotationSeq:0,baseLaneIds:['ab'.repeat(32)],contactSecrets:['cd'.repeat(32)]},journal:{revision:1,clock:100,enabled:true,descriptor:{channelId:'ab'.repeat(32),revision:1,encryptionEpub:fixture.mint.epub,expiresAt:500,maxLifetimeSeconds:300,maxMessageBytes:1024},rows:[]},contacts:[],messages:[],seen:[],outbox:[],sent:[]};
 let locked=false;
 const guard=()=>{if(locked)throw Error('locked');};
 const vault={owner,guard,load:async()=>({value:structuredClone(value)}),state:()=>({context:{now:100}}),change:async(work:(v:ContactVault,at:number)=>unknown,_signal:AbortSignal,validate=()=>{})=>{guard();const next=structuredClone(value),result=work(next,100);validate();value=next;return result;}} as unknown as ContactVaultStore;
 const selected={requestId:'ab'.repeat(32),replayKey:'cd'.repeat(32),replayUntil:500,request:{sender:peer}} as VerifiedFirstContact;
 const journal=contactJournal(vault,new AbortController().signal,selected);
 return {journal,selected,vault,value:()=>structuredClone(value),block:()=>{value.contacts=[{principal:peer,blocked:true}];},lock:()=>{locked=true;}};
}
test('acceptance stores the exact grant and contact together; acknowledgement requires those bytes',async()=>{
 const f=setup(),d=await f.journal.descriptor(),r={replayKey:f.selected.replayKey,requestId:f.selected.requestId,replayUntil:500,expiresAt:200,envelope:new Uint8Array(94)};
 assert.equal(await f.journal.reserve(d,r),true);assert.equal(await f.journal.reserve(d,r),false);
 const ciphertextHex='ef'.repeat(100);
 await f.journal.decide(d,r.replayKey,r.requestId,{status:'accepted',ciphertextHex,rotationSeq:0},()=>{});
 assert.equal(f.value().contacts[0].principal,peer);assert.equal((await f.journal.outbox())[0].grant?.ciphertextHex,ciphertextHex);
 await assert.rejects(f.journal.acknowledge(r.replayKey,r.requestId,'ab'.repeat(100)));assert.equal((await f.journal.outbox()).length,1);
 await f.journal.acknowledge(r.replayKey,r.requestId,ciphertextHex);assert.equal((await f.journal.outbox()).length,0);
});
test('authority refusal or a durable block prevents acceptance from changing the journal',async()=>{
 const f=setup(),d=await f.journal.descriptor(),r={replayKey:f.selected.replayKey,requestId:f.selected.requestId,replayUntil:500,expiresAt:200,envelope:new Uint8Array(94)};
 await f.journal.reserve(d,r);const decision={status:'accepted' as const,ciphertextHex:'ef'.repeat(100),rotationSeq:0};
 await assert.rejects(f.journal.decide(d,r.replayKey,r.requestId,decision,()=>{throw Error('authority changed');}));
 assert.equal(f.value().journal.rows[0].status,'pending');assert.equal(f.value().contacts.length,0);
 f.block();await assert.rejects(f.journal.decide(d,r.replayKey,r.requestId,decision));assert.equal(f.value().journal.rows[0].status,'pending');
 f.lock();await assert.rejects(f.journal.pending(d));
});

test('re-enabling after a public disable advances descriptor and private revision atomically',async()=>{
 const f=setup(),signal=new AbortController().signal;await f.journal.disable();
 assert.equal(f.value().journal.revision,1);assert.equal(f.value().journal.enabled,false);
 const descriptor=await activateContactJournal(f.vault,signal,{encryptionEpub:fixture.mint.epub,expiresAt:500,maxLifetimeSeconds:300,maxMessageBytes:1024},2);
 assert.equal(descriptor.revision,3);assert.equal(parseContactVault(f.value(),owner).journal.descriptor?.revision,3);
 assert.equal(f.value().journal.enabled,true);
 await assert.rejects(activateContactJournal(f.vault,signal,{encryptionEpub:fixture.mint.epub,expiresAt:500,maxLifetimeSeconds:300,maxMessageBytes:1024},0));
});
