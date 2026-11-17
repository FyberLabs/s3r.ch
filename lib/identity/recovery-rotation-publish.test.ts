import assert from 'node:assert/strict';
import {test} from 'node:test';
import vectors from './vectors/forum-rotation-record.json';
import {publishRecoveryRotation} from './recovery-rotation-publish';
const record:any=vectors.accept.find((r:any)=>r.input.nextEpub&&r.input.authorizer.kind==='wallet')!.input;
const old={sequence:record.seq-1,currentKey:record.prevKey,currentEpub:record.prevKey};
const next={sequence:record.seq,currentKey:record.nextKey,currentEpub:record.nextEpub},hash='ab'.repeat(32);
function fixture(){
 let present=false,writes=0,active=true;const abort=new AbortController();
 return {abort,get writes(){return writes;},stop(){active=false;},stored(){present=true;},
 input:{current:()=>active,signal:abort.signal,authorize:async()=>{},
 read:async()=>({recordHash:hash,present,head:present?next:old}),
 write:async(value:unknown)=>{assert.deepEqual(value,record);writes++;present=true;return {recordHash:hash};}}};
}
test('publish confirms the exact record and never resends an already published rotation',async()=>{
 const f=fixture();assert.equal(await publishRecoveryRotation(record,old,f.input),'published');
 assert.equal(await publishRecoveryRotation(record,old,f.input),'already-published');assert.equal(f.writes,1);
});
test('ambiguous success is read back once and an uncommitted write is never retried',async()=>{
 for(const committed of [true,false]){
  const f=fixture(),write=f.input.write;let calls=0;
  f.input.write=async value=>{calls++;if(committed)await write(value);throw Error('lost');};
  if(committed)assert.equal(await publishRecoveryRotation(record,old,f.input),'published');
  else await assert.rejects(publishRecoveryRotation(record,old,f.input),/unconfirmed/);
  assert.equal(calls,1);
 }
});
test('bad or changed authority and refusal never publish',async()=>{
 for(const mode of ['record','head','read','changed','authorize','cancel','context','already']){
  const f=fixture();let value=record,head=old;
  if(mode==='record')value={...record,priv:'secret'};
  if(mode==='head')head={...old,sequence:old.sequence+1};
  if(mode==='read')f.input.read=async()=>({recordHash:'bad',present:false,head:old});
  if(mode==='changed')f.input.read=async()=>({recordHash:hash,present:false,head:next});
  if(mode==='already')f.input.read=async()=>({recordHash:hash,present:true,head:old});
  if(mode==='authorize')f.input.authorize=async()=>{throw Error('refused');};
  if(mode==='cancel')f.input.authorize=async()=>{f.abort.abort();};
  if(mode==='context')f.input.authorize=async()=>{f.stop();};
  await assert.rejects(publishRecoveryRotation(value,head,f.input));assert.equal(f.writes,0);
 }
});
test('wrong hash, head, response and cancellation refuse success after a single write',async()=>{
 for(const mode of ['hash','head','reply','cancel','context']){
  const f=fixture(),write=f.input.write;
  f.input.write=async value=>{const result=await write(value);
   if(mode==='hash')f.input.read=async()=>({recordHash:'cd'.repeat(32),present:true,head:next});
   if(mode==='head')f.input.read=async()=>({recordHash:hash,present:true,head:old});
   if(mode==='cancel')f.abort.abort();if(mode==='context')f.stop();
   return mode==='reply'?{recordHash:'cd'.repeat(32)}:result;};
  await assert.rejects(publishRecoveryRotation(record,old,f.input));assert.equal(f.writes,1);
 }
});
test('public inputs are snapshotted before authority callbacks',async()=>{
 const f=fixture(),copy=structuredClone(record),head={...old};
 f.input.authorize=async()=>{copy.principal='changed';head.sequence=999;};
 assert.equal(await publishRecoveryRotation(copy,head,f.input),'published');
});
