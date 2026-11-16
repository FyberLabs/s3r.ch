import assert from 'node:assert/strict';
import test from 'node:test';
import { blobForumRequest } from './forum-request';
import { emptyForumFile, handleForumPost } from './forum';
import type { AsyncForumClient } from './forum-blob-async';
const owner='PtETt4g7TFkGODedsMIc2hZ0LtAlUEi_QzOR03S8IdE.kJkgmszEyKIkyEOvpPTGigkNBNpemIna4vju_OgqN0A';
const text=JSON.stringify({schema:1,admittedOwners:[owner],forum:emptyForumFile(),snapshots:[]});
const write=(entropy:string)=>(forum:Parameters<Parameters<typeof blobForumRequest>[2]>[0])=>{
  const result=handleForumPost(forum,owner,{action:'register',label:entropy,entropy});
  return Response.json(result.body,{status:result.status});
};
test('slow storage yields the event loop and success waits for durable commit', async () => {
  let download:()=>void=()=>{},upload:()=>void=()=>{},finished=false;
  const client:AsyncForumClient={
    download:()=>new Promise(resolve=>{download=()=>resolve({found:true,text,etag:'1'});}),
    upload:()=>new Promise(resolve=>{upload=resolve;}),
  };
  const pending=blobForumRequest(client,owner,write('one')).then(response=>{finished=true;return response;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  download();await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  upload();assert.equal((await pending).status,200);
});
test('two concurrent colors cannot acknowledge conflicting writes', async () => {
  let current=text,etag='1';
  const client:AsyncForumClient={
    async download(){const hit={found:true as const,text:current,etag};await new Promise(resolve=>setImmediate(resolve));return hit;},
    async upload(next,conditions){if(conditions.ifMatch!==etag)throw Object.assign(new Error('conflict'),{statusCode:412});current=next;etag=String(Number(etag)+1);},
  };
  const responses=await Promise.all([blobForumRequest(client,owner,write('first')),blobForumRequest(client,owner,write('second'))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,200]);
  assert.equal(JSON.parse(current).forum.bots.length,2);
});
test('failed and missing storage cannot produce a success or an empty replacement', async () => {
  for(const download of [async()=>({found:false as const}),async()=>{throw new Error('unavailable');}]) {
    let writes=0;
    const result=await blobForumRequest({download,upload:async()=>{writes++;}},owner,write('one'));
    assert.equal(result.status,503);assert.equal(writes,0);
  }
});
test('unregistered principals cannot execute model code or consume a reservation', async () => {
  const client:AsyncForumClient={download:async()=>({found:true,text,etag:'1'}),upload:async()=>{throw new Error('must not write');}};
  const response=await blobForumRequest(client,'unregistered',()=>{throw new Error('must not execute');});
  assert.equal(response.status,403);
});
test('deployment admission refuses a new principal before attempting Azure I/O', async () => {
  const {forumRequest}=await import('./forum-request');
  const previous={mode:process.env.S3RCH_FORUM_STORAGE,owners:process.env.S3RCH_FORUM_ADMITTED_OWNERS};
  process.env.S3RCH_FORUM_STORAGE='blob';process.env.S3RCH_FORUM_ADMITTED_OWNERS=JSON.stringify([owner]);
  try {assert.equal((await forumRequest('unregistered',()=>{throw new Error('must not execute');})).status,403);}
  finally {
    if(previous.mode===undefined)delete process.env.S3RCH_FORUM_STORAGE;else process.env.S3RCH_FORUM_STORAGE=previous.mode;
    if(previous.owners===undefined)delete process.env.S3RCH_FORUM_ADMITTED_OWNERS;else process.env.S3RCH_FORUM_ADMITTED_OWNERS=previous.owners;
  }
});

test('persistent conflicts stop after four fresh attempts without acknowledgement',async()=>{
  let reads=0,writes=0;
  const response=await blobForumRequest({
    async download(){reads++;return {found:true,text,etag:String(reads)};},
    async upload(){writes++;throw Object.assign(new Error('conflict'),{statusCode:412});}
  },owner,write('bounded'));
  assert.equal(response.status,409);assert.equal(reads,4);assert.equal(writes,4);
});
