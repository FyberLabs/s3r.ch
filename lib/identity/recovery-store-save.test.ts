import assert from 'node:assert/strict';
import {test} from 'node:test';
import {saveRecoveryCopy} from './recovery-store-save';
const p='axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const row={principal:p,signingPub:p,epub:p,rotationSeq:0,bytesHex:'01'+'00'.repeat(60)},head={sequence:0,currentKey:p,currentEpub:p};
function fixture(){let stored:any=null,generation=0,writes=0,signs=0,active=true;const abort=new AbortController();return {
 get writes(){return writes;},get signs(){return signs;},abort,stop(){active=false;},set(value:any,g=0){stored=value;generation=g;},
 input:{signal:abort.signal,current:()=>active,read:async()=>({generation,head,row:stored}),authorize:async()=>{},
 sign:async()=>{signs++;return {action:'put',row,signature:'00'.repeat(64)};},
 write:async()=>{writes++;stored={...row};generation++;return {generation};}}
};}
test('save verifies exact read-back and an existing identical row needs no write',async()=>{
 const f=fixture();assert.equal(await saveRecoveryCopy(row,f.input),'stored');assert.equal(f.writes,1);
 assert.equal(await saveRecoveryCopy(row,f.input),'already-stored');assert.equal(f.writes,1);assert.equal(f.signs,1);
});
test('lost success is reconciled once; loss before commit is not retried',async()=>{
 for(const committed of [true,false]){const f=fixture(),write=f.input.write;let calls=0;f.input.write=async()=>{calls++;if(committed)await write();throw Error('lost');};
  if(committed)assert.equal(await saveRecoveryCopy(row,f.input),'stored');else await assert.rejects(saveRecoveryCopy(row,f.input),/unconfirmed/);
  assert.equal(calls,1);
 }
});
test('changed generation, row, authority and cancellation refuse success',async()=>{
 for(const mode of ['generation','row','authority','cancel','context','reply']){const f=fixture(),write=f.input.write;
  f.input.write=async()=>{const result=await write();if(mode==='generation')f.set(row,2);if(mode==='row')f.set({...row,bytesHex:'01'+'11'.repeat(60)},1);
   if(mode==='authority')f.input.read=async()=>({generation:1,head:{...head,sequence:1},row});if(mode==='cancel')f.abort.abort();if(mode==='context')f.stop();
   return mode==='reply'?{generation:9}:result;};
  await assert.rejects(saveRecoveryCopy(row,f.input));assert.equal(f.writes,1);
 }
});
test('invalid read/signature, exhausted generation and owner refusal never write',async()=>{
 for(const mode of ['read','sign','generation','owner']){const f=fixture();
  if(mode==='read')f.input.read=async()=>({generation:-1,head,row:null});
  if(mode==='sign')f.input.sign=async()=>({action:'put',row,signature:'bad'});
  if(mode==='generation')f.set(null,Number.MAX_SAFE_INTEGER);
  if(mode==='owner')f.input.authorize=async()=>{throw Error('owner changed');};
  await assert.rejects(saveRecoveryCopy(row,f.input));assert.equal(f.writes,0);
 }
 const f=fixture();await assert.rejects(saveRecoveryCopy({...row,principal:'bad'},f.input));assert.equal(f.writes,0);
});
