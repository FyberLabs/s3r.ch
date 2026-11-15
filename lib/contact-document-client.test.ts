import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openContactDocuments,contactBase64} from './contact-document-client';
import fixture from './identity/vectors/contact-acceptance.json';
const owner=fixture.mint,now=100,pair={pub:owner.signingPub,priv:owner.signingPriv,epub:owner.epub,epriv:owner.epriv};
const tenant='12345678-1234-1234-1234-123456789abc',source='23456789-1234-1234-1234-123456789abc';
function setup(){
 let revision=0,payload:string|null=null,writes=0,unlocked=true,lose=true;
 const fetcher=(async(url,init)=>{
  assert.equal(init?.credentials,'same-origin');assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');
  const body=JSON.parse(String(init?.body));
  if(url==='/api/contacts/config')return Response.json({at:now,tenant,source,principal:pair.pub,currentKey:pair.pub,trust:{jwks:{keys:[]},policy:{},pinnedIss:[]}});
  if(url==='/api/contacts/read')return Response.json({at:now,owner:pair.pub,kind:body.kind,revision,fence:'ef'.repeat(32),payload,head:{currentKey:pair.pub,currentEpub:pair.epub,sequence:0,history:{completeThrough:now,accounts:[],links:[]}}});
  assert.equal(url,'/api/contacts/write');assert.equal(body.revision,revision);writes++;revision++;payload=body.payload;
  if(lose){lose=false;throw Error('Lost response');}
  return Response.json({at:now,revision,digest:createHash('sha256').update(Buffer.from(body.payload,'base64')).digest('hex')});
 }) as typeof fetch;
 return {fetcher,current:()=>unlocked,lock:()=>{unlocked=false;},change:()=>{revision++;payload=contactBase64(new Uint8Array(28).fill(9));},writes:()=>writes};
}
test('ambiguous vault update reconciles committed bytes without a second write',async()=>{
 const f=setup(),signal=new AbortController().signal,client=await openContactDocuments(pair,f.current,signal,f.fetcher,()=>now);
 const input=new Uint8Array(28).fill(1),prepared=await client.prepare('vault',0,input,signal);input.fill(2);
 await assert.rejects(prepared.submit(signal),/Lost response/);
 assert.equal(await prepared.submit(signal),1);assert.equal(f.writes(),1);
});
test('intervening decisions and a locked identity prevent prepared writes',async()=>{
 const f=setup(),signal=new AbortController().signal,client=await openContactDocuments(pair,f.current,signal,f.fetcher,()=>now);
 const prepared=await client.prepare('vault',0,new Uint8Array(28),signal);
 f.change();await assert.rejects(prepared.submit(signal));assert.equal(f.writes(),0);
 f.lock();await assert.rejects(client.read(pair.pub,'vault',signal));
});

test('a prepared vault decision cannot silently adopt a changed authority fence',async()=>{
 const f=setup(),signal=new AbortController().signal,client=await openContactDocuments(pair,f.current,signal,f.fetcher,()=>now);
 const prepared=await client.prepare('vault',0,new Uint8Array(28),signal,'ab'.repeat(32));
 await assert.rejects(prepared.submit(signal));assert.equal(f.writes(),0);
});
