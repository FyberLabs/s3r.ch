import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commitRecoveryCopy} from './recovery-store-commit';
import type {RecoveryRow} from './recovery-store-save';
const p='axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const row={principal:p,signingPub:p,epub:p,rotationSeq:1,bytesHex:'01'+'00'.repeat(60)};
const head={sequence:1,currentKey:p,currentEpub:p};
function fixture(){
 let generation=1,current:RecoveryRow|null=null,pending:RecoveryRow|null=row,writes=0,active=true;const abort=new AbortController();
 return {abort,get writes(){return writes;},stop(){active=false;},
 set(c:RecoveryRow|null,q:RecoveryRow|null,g=1){current=c;pending=q;generation=g;},
 input:{current:()=>active,signal:abort.signal,authorize:async()=>{},
 read:async(slot:'current'|'pending')=>({generation,head,row:slot==='current'?current:pending}),
 sign:async()=>({action:'commit',signature:'00'.repeat(64)}),
 write:async()=>{writes++;current=pending;pending=null;generation++;return {generation};}}};
}
test('promotion verifies both slots and exact repeat performs no write',async()=>{
 const f=fixture();assert.equal(await commitRecoveryCopy(row,f.input),'committed');assert.equal(f.writes,1);
 assert.equal(await commitRecoveryCopy(row,f.input),'already-committed');assert.equal(f.writes,1);
});
test('ambiguous promotion is read back once without resending',async()=>{
 for(const committed of [true,false]){const f=fixture(),write=f.input.write;let calls=0;
  f.input.write=async()=>{calls++;if(committed)await write();throw Error('lost');};
  if(committed)assert.equal(await commitRecoveryCopy(row,f.input),'committed');
  else await assert.rejects(commitRecoveryCopy(row,f.input),/unconfirmed/);
  assert.equal(calls,1);
 }
});
test('invalid, foreign, stale or inconsistent signing inputs never write',async()=>{
 for(const mode of ['row','read','owner','head','generation','pending','exhausted','authority','signature','cancel','context']){
  const f=fixture();let expected=row;
  if(mode==='row')expected={...row,bytesHex:'bad'};
  if(mode==='read')f.input.read=async()=>({generation:-1,head,row});
  if(mode==='owner')f.set(null,{...row,principal:'fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E'});
  if(mode==='head')f.input.read=async()=>({generation:1,head:{...head,sequence:0},row});
  if(mode==='generation')f.input.read=async slot=>({generation:slot==='current'?1:2,head,row});
  if(mode==='pending')f.set(null,null);
  if(mode==='exhausted')f.set(null,row,Number.MAX_SAFE_INTEGER);
  if(mode==='authority')f.input.authorize=async()=>{throw Error('revoked');};
  if(mode==='signature')f.input.sign=async()=>({action:'commit',signature:'bad'});
  if(mode==='cancel')f.input.authorize=async()=>{f.abort.abort();};
  if(mode==='context')f.input.authorize=async()=>{f.stop();};
  await assert.rejects(commitRecoveryCopy(expected,f.input));assert.equal(f.writes,0);
 }
});
test('changed rows, generations and replies after commit refuse success',async()=>{
 for(const mode of ['current','pending','generation','reply','cancel','authority']){
  const f=fixture(),write=f.input.write;
  f.input.write=async()=>{const result=await write();
   if(mode==='current')f.set({...row,bytesHex:'01'+'11'.repeat(60)},null,2);
   if(mode==='pending')f.set(row,row,2);
   if(mode==='generation')f.set(row,null,3);
   if(mode==='cancel')f.abort.abort();
   if(mode==='authority')f.input.authorize=async()=>{throw Error('revoked');};
   return mode==='reply'?{generation:99}:result;};
  await assert.rejects(commitRecoveryCopy(row,f.input));assert.equal(f.writes,1);
 }
});
test('expected encrypted copy is snapshotted before asynchronous authority checks',async()=>{
 const f=fixture(),copy={...row};f.input.authorize=async()=>{copy.rotationSeq=99;};
 assert.equal(await commitRecoveryCopy(copy,f.input),'committed');
});
