import {createAllocatedMediaService} from "./allocated-media-service";
import {createMediaGroupService} from "./media-group-service";
// File crypto, group authorization and HTTP contracts execute only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {wrapGroupKeyToMembers} from "sociacl-ids/group-reader-wrap";
import {wrapItemDekToGroupEpoch} from "sociacl-ids/group-wrap";
import {prepareMediaFile} from "./media-file";
import {shareDigest} from "./media-share-journal";
import {openGroupMediaFile} from "./media-group-item-file";
import {reader,object,scope} from "./media-group-item-epoch-fixture";
const epub="EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv="6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8";
const tenant='11111111-1111-4111-8111-111111111111',plain=new Uint8Array([1,2,3]),description={name:'shared.png',mediaType:'image/png'};
async function fixture(){
  const sealed=await prepareMediaFile(plain,description,{tenant,object}),groupKey=new Uint8Array(32).fill(7),reference={sha256:sealed.sha256,length:sealed.bytes.length};
  const key=await wrapGroupKeyToMembers(groupKey,{group:scope.set,epoch:3,revisionId:'c'.repeat(64)},[{account:reader,pub:reader,identityPub:reader,epub}],[reader]);assert.ok(key.ok);
  const encode=(v:unknown)=>btoa(JSON.stringify(v));
  async function item(epoch:number,revision:string){
    const wrap=await wrapItemDekToGroupEpoch(sealed.key,groupKey,{object,group:scope.set,epoch,revisionId:revision});assert.ok(wrap.ok);
    return {payload:encode({wrap:wrap.value,reference}),object,predicate:scope.predicate,set_id:scope.set,item_epoch:epoch,item_revision_id:revision,item_digest:reference.sha256,
      group_epoch:3,group_revision_id:'c'.repeat(64),group_key_commitment:await shareDigest(groupKey)};
  }
  const current=await item(2,'a'.repeat(64)),changed=await item(3,'e'.repeat(64));sealed.key.fill(0);groupKey.fill(0);
  let now=100,groups=0,mode='normal';const calls:string[]=[];
  let authorizedReads=0,directReads=0;
  const groupService=createMediaGroupService({origin:'https://acl.example',tenant,readers:[{principal:reader,apiKey:'fixture-only'}]},'https://s3r.ch',async()=>reader,
    async(url,init)=>{assert.ok(String(url).endsWith('/item-wrap-read'));assert.equal(new Headers(init?.headers).get('X-Api-Key'),'fixture-only');
      assert.deepEqual(JSON.parse(init?.body as string),{object,...scope});authorizedReads++;
      if(mode==='deny-download'||(mode==='revoke-download'&&authorizedReads===2))return new Response(null,{status:403});
      return Response.json({...current,expires_at:now+2});},()=>now);
  const objectService=createAllocatedMediaService({origin:'https://s3r.ch',owner:()=>null,
    wrap:()=>async()=>{directReads++;return new Response(null,{status:403});},group:()=>groupService,
    allocated:{reference:async()=>({digest:reference.sha256,length:reference.length}),get:async()=>sealed.bytes,put:async()=>{throw Error('read only');}}});
  const input={tenant,principal:reader,object,scope,epriv,epub,clock:()=>now,signal:new AbortController().signal,
    fetcher:async(url:unknown,init?:RequestInit)=>{
      const path=String(url);calls.push(path);assert.equal(init?.credentials,'same-origin');assert.equal(init?.redirect,'error');
      if(path.endsWith('/wrap-read')){groups++;return Response.json({payload:encode(key.value[0]),predicate:scope.predicate,set_id:scope.set,epoch:3,revision_id:'c'.repeat(64),reader_epub:epub,key_commitment:current.group_key_commitment,expires_at:now+2});}
      if(path.endsWith('/item-wrap-read')){
        if(mode==='revoke'&&groups===3)return new Response(null,{status:403});
        return Response.json({...((mode==='change-before'&&groups>=2)||(mode==='change-after'&&groups===3)?changed:current),expires_at:now+2});
      }
      now=200;const headers=new Headers(init?.headers);headers.set('origin','https://s3r.ch');return objectService(new Request('https://s3r.ch'+path,{...init,headers}),object);
    }};
  return {input,calls,authorization:()=>({authorizedReads,directReads}),setMode:(value:string)=>{mode=value;}};
}
test("group file fetch obtains fresh authorization after transfer and after decryption",async()=>{
  const f=await fixture(),file=await openGroupMediaFile(f.input);
  assert.deepEqual(file.bytes,plain);assert.deepEqual(file.description,description);file.bytes.fill(0);
  assert.deepEqual(f.authorization(),{authorizedReads:2,directReads:0});
  assert.equal(f.calls.filter(p=>p.endsWith('/wrap-read')).length,3);
  assert.equal(f.calls.filter(p=>p.endsWith('/item-wrap-read')).length,6);
  assert.equal(f.calls[3],'/api/media/'+encodeURIComponent(object)+'?'+new URLSearchParams(scope));
});
test("changed epochs and post-decryption revocation never return a file",async()=>{
  for(const mode of ['change-before','change-after','revoke','deny-download','revoke-download']){const f=await fixture();f.setMode(mode);await assert.rejects(openGroupMediaFile(f.input));}
});
test("wrong tenant binding, cancellation and failed ciphertext transfer refuse",async()=>{
  const f=await fixture();await assert.rejects(openGroupMediaFile({...f.input,tenant:'22222222-2222-4222-8222-222222222222'}));
  const stop=new AbortController();stop.abort();await assert.rejects(openGroupMediaFile({...f.input,signal:stop.signal}));
  const g=await fixture(),base=g.input.fetcher;g.input.fetcher=async(url,init)=>String(url).includes('/groups/')?base(url,init):new Response(null,{status:503});
  await assert.rejects(openGroupMediaFile(g.input));
});
