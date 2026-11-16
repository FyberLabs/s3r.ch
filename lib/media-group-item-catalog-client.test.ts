// HTTP and protected proxy contracts execute in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {readGroupGranted} from "./media-group-item-catalog-client";
import {createMediaGroupService} from "./media-group-service";
import {reader,object,scope} from "./media-group-item-epoch-fixture";
const page={at:100,entries:[{object,...scope}],nextPage:1};
test("group Granted transport binds session and preserves scoped results",async()=>{
 const fetcher:typeof fetch=async(url,init)=>{assert.equal(String(url),'/api/media/groups/item-reader-catalog');assert.equal(init?.credentials,'same-origin');assert.equal(init?.redirect,'error');assert.deepEqual(JSON.parse(String(init?.body)),{page:0});return Response.json(page);};
 assert.deepEqual(await readGroupGranted(0,reader,fetcher,undefined,()=>100),page);
 const tenant='11111111-1111-4111-8111-111111111111';let reads=0,changed=false;
 const handle=createMediaGroupService({origin:'https://acl.example',tenant,readers:[{principal:reader,apiKey:'private-key'}]},'https://site.example',
  async()=>{reads++;return changed&&reads%2===0?null:reader;},async(url,init)=>{
   assert.equal(String(url),'https://acl.example/api/v1/acl/sociacl/media/groups/item-reader-catalog');assert.equal(new Headers(init?.headers).get('x-api-key'),'private-key');return Response.json(page);
  },()=>100);
 const request=(body:unknown)=>new Request('https://site.example/api/media/groups/item-reader-catalog',{method:'POST',headers:{origin:'https://site.example','content-type':'application/json'},body:JSON.stringify(body)});
 const response=await handle('item-reader-catalog',request({page:0}));assert.equal(response.status,200);assert.deepEqual(await response.json(),page);
 assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await handle('item-reader-catalog',request({page:0,reader}))).status,400);
 reads=0;changed=true;assert.equal((await handle('item-reader-catalog',request({page:0}))).status,403);
});
test("failed, stale, oversized and aborted catalog reads fail closed",async()=>{
 for(const response of [()=>new Response(null,{status:403}),()=>new Response('{}'),()=>Response.json({...page,at:90}),()=>new Response(' '.repeat(8193),{headers:{'content-type':'application/json'}})])
  await assert.rejects(readGroupGranted(0,reader,async()=>response(),undefined,()=>100));
 const stopped=new AbortController();stopped.abort();await assert.rejects(readGroupGranted(0,reader,async()=>{throw Error('must not fetch');},stopped.signal,()=>100));
});
