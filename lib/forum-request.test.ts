import assert from 'node:assert/strict';
import test from 'node:test';
import { blobForumRequest } from './forum-request';
import { emptyForumFile, handleForumPost } from './forum';
import type { AsyncForumClient } from './forum-blob-async';
const owner='PtETt4g7TFkGODedsMIc2hZ0LtAlUEi_QzOR03S8IdE.kJkgmszEyKIkyEOvpPTGigkNBNpemIna4vju_OgqN0A';
const text=JSON.stringify({schema:1,forum:emptyForumFile(),snapshots:[]});
const write=(entropy:string)=>(forum:Parameters<Parameters<typeof blobForumRequest>[1]>[0])=>{
  const result=handleForumPost(forum,owner,{action:'register',label:entropy,entropy});
  return Response.json(result.body,{status:result.status});
};
test('slow storage yields the event loop and success waits for durable commit', async () => {
  let download:()=>void=()=>{},upload:()=>void=()=>{},finished=false;
  const client:AsyncForumClient={
    download:()=>new Promise(resolve=>{download=()=>resolve({found:true,text,etag:'1'});}),
    upload:()=>new Promise(resolve=>{upload=resolve;}),
  };
  const pending=blobForumRequest(client,write('one')).then(response=>{finished=true;return response;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  download();await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  upload();assert.equal((await pending).status,200);
});
test('two concurrent colors cannot acknowledge conflicting writes', async () => {
  let current=text,etag='1';
  const client:AsyncForumClient={
    async download(){const hit={found:true as const,text:current,etag};await new Promise(resolve=>setImmediate(resolve));return hit;},
    async upload(next,conditions){if(conditions.ifMatch!==etag)throw Object.assign(new Error('conflict'),{statusCode:412});current=next;etag='2';},
  };
  const responses=await Promise.all([blobForumRequest(client,write('first')),blobForumRequest(client,write('second'))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal(JSON.parse(current).forum.bots.length,1);
});
test('failed and missing storage cannot produce a success or an empty replacement', async () => {
  for(const download of [async()=>({found:false as const}),async()=>{throw new Error('unavailable');}]) {
    let writes=0;
    const result=await blobForumRequest({download,upload:async()=>{writes++;}},write('one'));
    assert.equal(result.status,503);assert.equal(writes,0);
  }
});
