// Signing, HTTP and encrypted-store contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {wrapItemDekToReaders,openItemDekReaderWrap} from "sociacl-ids";
import {owner,reader,object,scope,plan as fixture} from "./media-group-item-epoch-fixture";
import {createShareJournal,decryptShareJournal,shareDigest} from "./media-share-journal";
import {applyEpochDelivery,pendingEpochDelivery,discardEpochDelivery} from "./media-group-item-epoch-delivery";
import {createMediaGroupService} from "./media-group-service";
const tenant="11111111-1111-4111-8111-111111111111",pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:owner,epriv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"};
const target={object,...scope};
async function setup(){
  const dek=new Uint8Array(32).fill(7),context={object,epoch:1,revisionId:"a".repeat(64)};
  const wrapped=await wrapItemDekToReaders(dek,context,[{account:owner,pub:owner,identityPub:owner,epub:owner}],[owner]);assert.ok(wrapped.ok);
  const reference={sha256:"a".repeat(64),length:100},payload=Buffer.from(JSON.stringify({wrap:wrapped.value[0],reference})).toString("base64");
  const plan=structuredClone(fixture);plan.keyCommitment=await shareDigest(dek);plan.grants.push({...plan.grants[0],accessor:reader});
  plan.groupReaders=[];plan.snapshot.entries[1]={...plan.snapshot.entries[0],accessor:reader};
  Object.assign(plan.bindings,{[reader]:{pub:reader,epub:reader,head:0}});
  let at=100,applied=false,lost=false,delay=false,deny=false,views=0,writes=0;
  const published=new Map<string,unknown>(),journal=createShareJournal(new IDBFactory(),"group-item-epoch-delivery"),signal=new AbortController().signal;
  const fetcher:typeof fetch=async(url,init)=>{
    const action=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));
    if(deny)return new Response(null,{status:503});
    if(action==='item-owner-wrap-read')return Response.json({object,...{predicate:scope.predicate,set_id:scope.set},epoch:1,revision_id:context.revisionId,
      reader_epub:owner,key_commitment:plan.keyCommitment,item_digest:reference.sha256,expires_at:at+2,payload});
    if(action==='item-epoch-view'){views++;return Response.json({...plan,at});}
    if(action==='item-epoch-state')return Response.json({at,state:applied?'applied':'absent'});
    if(action==='item-epoch-append'){
      const entry=(await journal.read(signal))!;assert.ok(entry);
      const saved=await decryptShareJournal(entry,tenant,pair,'group-item-epoch-delivery') as {wraps:unknown[]};assert.equal(saved.wraps.length,2);
      applied=true;writes++;if(lost)throw Error('lost');return Response.json({accepted:true});
    }
    if(action==='share-check')return Response.json({at,fence:plan.fence,state:published.has(body.payload.reader)?'applied':'absent'});
    if(action==='publish-wrap'){
      if(delay)return new Response(null,{status:403});published.set(body.metadata.reader,body);
      return Response.json({record:body.metadata.record,digest:body.metadata.digest});
    }
    if(action==='status-view')return Response.json({at,fence:plan.fence,ownerPub:owner,status:{object,epoch:2,revisionId:'f'.repeat(64),accessor:body.reader,
      grantRevision:2,stated:1,signedAt:at*1000,maxAgeMs:60000,zookie:{object,objectVersion:5,snapshotHash:'e'.repeat(64)}}});
    assert.equal(action,'mutate');assert.equal(body.operation,'status');return Response.json({accepted:true});
  };
  const scalar=new Uint8Array(32);scalar[31]=1;
  const input={tenant,principal:owner,pair,scalar,fetcher,signal,journal,clock:()=>at};
  return {input,published,dek,time:(v:number)=>{at=v;},lose:()=>{lost=true;},delay:(v:boolean)=>{delay=v;},deny:(v:boolean)=>{deny=v;},views:()=>views,writes:()=>writes};
}
test("retains replacement direct wraps before epoch write and reconciles all delivery",async()=>{
  const f=await setup();assert.equal(await pendingEpochDelivery(f.input),null);
  const result=await applyEpochDelivery({...f.input,target});assert.equal(result.pending,false);assert.equal(f.published.size,2);
  assert.equal(await pendingEpochDelivery(f.input),null);assert.equal(f.writes(),1);
  const body=f.published.get(owner) as {wrapBase64:string};const material=JSON.parse(Buffer.from(body.wrapBase64,'base64').toString());
  const opened=await openItemDekReaderWrap(material.wrap,pair.epriv,pair.epub,{object,epoch:material.wrap.epoch,revisionId:material.wrap.revisionId});
  assert.ok(opened.ok);assert.deepEqual(opened.value,f.dek);opened.value.fill(0);
});
test("accepted uncertain updates cannot discard their only replacement wraps",async()=>{
  const f=await setup();f.lose();await assert.rejects(applyEpochDelivery({...f.input,target}));
  const expected=(await pendingEpochDelivery(f.input))!;assert.ok(expected);
  await assert.rejects(discardEpochDelivery({...f.input,expected}));
  await assert.rejects(applyEpochDelivery({...f.input,target}));
  await assert.rejects(applyEpochDelivery({...f.input,expected:{...expected,token:'other'}}));
  f.time(1000);f.delay(true);assert.equal((await applyEpochDelivery({...f.input,expected})).pending,true);
  assert.ok(await pendingEpochDelivery(f.input));await assert.rejects(discardEpochDelivery({...f.input,expected}));
  f.delay(false);assert.equal((await applyEpochDelivery({...f.input,expected})).pending,false);
  assert.equal(f.views(),1);assert.equal(f.writes(),1);assert.equal(f.published.size,2);
});
test("owner identity and local storage refusal prevent mutation",async()=>{
  const f=await setup(),full={...f.input.journal,write:async()=>{throw Error('full');}};
  await assert.rejects(applyEpochDelivery({...f.input,journal:full,target}));assert.equal(f.writes(),0);
  f.lose();await assert.rejects(applyEpochDelivery({...f.input,target}));
  await assert.rejects(pendingEpochDelivery({...f.input,principal:reader}));
  await assert.rejects(discardEpochDelivery({...f.input,expected:{...target,epoch:2,token:'other'}}));
  f.deny(true);await assert.rejects(applyEpochDelivery({...f.input,expected:(await pendingEpochDelivery(f.input))!}));
});
test("owner-maintenance proxy is authenticated and returns bounded opaque context",async()=>{
  const f=await setup(),response=await f.input.fetcher('/api/media/groups/item-owner-wrap-read',{body:JSON.stringify(target)}),value=await response.json();
  let calls=0;const service=createMediaGroupService({origin:'https://acl.example',tenant,readers:[{principal:owner,apiKey:'private'}]},'https://site.example',async()=>owner,async()=>{calls++;return Response.json(value);},()=>100);
  const request=(body:unknown)=>new Request('https://site.example/api/media/groups/item-owner-wrap-read',{method:'POST',headers:{Origin:'https://site.example','Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await service('item-owner-wrap-read',request(target))).status,200);
  assert.equal((await service('item-owner-wrap-read',request({...target,reader}))).status,400);assert.equal(calls,1);
});
