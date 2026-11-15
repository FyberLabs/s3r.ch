import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseContactVault,type ContactVault} from './contact-vault';
import fixture from './identity/vectors/contact-acceptance.json';
const owner=fixture.mint.signingPub,peer=fixture.genesis.principal;
const initial=():ContactVault=>({v:1,owner,keyring:{rotationSeq:0,baseLaneIds:['ab'.repeat(32)],contactSecrets:['cd'.repeat(32)]},journal:{revision:0,clock:100,enabled:false,descriptor:null,rows:[]},contacts:[],messages:[],seen:[],outbox:[],sent:[]});
test('restored vault preserves secret history and rejects truncated, duplicated or foreign state',()=>{
 const original=initial(),parsed=parseContactVault(original,owner);parsed.keyring.contactSecrets[0]='ef'.repeat(32);assert.equal(original.keyring.contactSecrets[0],'cd'.repeat(32));
 for(const change of [(v:ContactVault)=>{v.owner=peer;},(v:ContactVault)=>{v.keyring.rotationSeq=1;},(v:ContactVault)=>{v.keyring.contactSecrets=[v.keyring.baseLaneIds[0]];},(v:ContactVault)=>{v.journal.enabled=true;},(v:ContactVault)=>{v.seen=[{id:'invalid',expiresAt:100}];}]){const value=initial();change(value);assert.throws(()=>parseContactVault(value,owner));}
});
test('stored messages must name this conversation and retry rows must retain encrypted commands',()=>{
 const value=initial();value.messages=[{id:'ab'.repeat(32),sender:peer,peer,body:'Hello'}];assert.equal(parseContactVault(value,owner).messages.length,1);
 value.messages[0].sender=fixture.mint.epub;assert.throws(()=>parseContactVault(value,owner));
 const other=initial();other.outbox=[{id:'ab'.repeat(32),peer,lane:'ef'.repeat(32),kind:'text',body:'Hello',ciphertext:'',grant:'ab'.repeat(100)}];assert.throws(()=>parseContactVault(other,owner));
});
