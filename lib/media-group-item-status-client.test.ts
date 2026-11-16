// Native signing, HTTP and encrypted recovery contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createItemStatusClient,parseSignedItemStatus} from "./media-group-item-status-client";
import {applyItemStatus,pendingItemStatus,discardItemStatus} from "./media-group-item-status-recovery";
import {createShareJournal} from "./media-share-journal";
import {createMediaGroupService} from "./media-group-service";
import {IDBFactory} from "fake-indexeddb";
import type {SeaPair} from "./identity/sea";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")},fence="a".repeat(64);
const draft={object,...scope,reader};
const status={object,accessor:reader,stated:1 as const,epoch:2,grantRevision:1,revisionId:fence,signedAt:100000,maxAgeMs:60000,zookie:{object,objectVersion:3,snapshotHash:fence}};

const key=()=>{const k=new Uint8Array(32);k[31]=1;return k;};
function backend(){
  let at=100,applied=false,lost=false,bad=false;const calls:{action:string;body:Record<string,unknown>}[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    const action=String(url).split("/").at(-1)!,body=JSON.parse(String(init?.body));calls.push({action,body});
    assert.equal(init?.credentials,"same-origin");assert.equal(init?.redirect,"error");
    if(bad)return new Response("unavailable",{status:503});
    if(action==="item-status-view")return Response.json({at,fence,ownerPub:owner,status});
    if(action==="item-status-state")return Response.json({at,state:applied?"applied":"absent"});
    applied=true;if(lost)throw Error("lost reply");return Response.json({accepted:true});
  };
  return {fetcher,calls,clock:()=>at,time:(v:number)=>{at=v;},lose:()=>{lost=true;},fail:()=>{bad=true;},applied:()=>{applied=true;}};
}
test("sign current draft and reconcile exact retained command without refreshing",async()=>{
  const b=backend(),c=createItemStatusClient(owner,b.fetcher,b.clock),scalar=key(),command=await c.prepare(draft,scalar);
  assert.equal(scalar[31],1);assert.equal(command.ownerPub,owner);
  assert.equal((await c.apply(command)).state,"applied");b.time(1000);
  assert.equal((await c.apply(command)).state,"applied");
  assert.equal(b.calls.filter(r=>r.action==="item-status-view").length,1);
  assert.deepEqual(b.calls.find(r=>r.action==="item-status-append")!.body,command.body);
  assert.equal(b.calls.filter(r=>r.action==="item-status-append").length,1);
});
test("expired or future absent commands cannot be applied",async()=>{
  for(const mode of ["old","future"]){
    const b=backend(),c=createItemStatusClient(owner,b.fetcher,b.clock),command=await c.prepare(draft,key());
    if(mode==="old")b.time(105);else b.time(99);
    await assert.rejects(c.apply(command));assert.equal(b.calls.filter(r=>r.action==="item-status-append").length,0);
  }
});
test("invalid inputs and failed transport never sign replacement commands",async()=>{
  assert.throws(()=>createItemStatusClient("bad"));
  for(const v of [null,{},[],{ownerPub:"bad",body:{}},{ownerPub:owner,body:{},extra:1}])assert.throws(()=>parseSignedItemStatus(v,owner));
  const b=backend(),c=createItemStatusClient(owner,b.fetcher,b.clock);
  await assert.rejects(c.prepare(draft,new Uint8Array(1)));
  const wrong=key();wrong[31]=2;await assert.rejects(c.prepare(draft,wrong));
  const aborted=new AbortController();aborted.abort();await assert.rejects(c.prepare(draft,key(),aborted.signal));
  b.fail();await assert.rejects(c.prepare(draft,key()));
});
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:owner,epriv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"} as SeaPair;
function recovery(b:ReturnType<typeof backend>){return {tenant:"11111111-1111-4111-8111-111111111111",principal:owner,pair,fetcher:b.fetcher,clock:b.clock,signal:new AbortController().signal,journal:createShareJournal(new IDBFactory(),"group-item-status")};}
test("lost write reply retains encrypted command and exact recovery clears it",async()=>{
  const b=backend(),input=recovery(b),command=await createItemStatusClient(owner,b.fetcher,b.clock).prepare(draft,key());
  assert.equal(await pendingItemStatus(input),null);b.lose();await assert.rejects(applyItemStatus({...input,command}));
  const expected=(await pendingItemStatus(input))!;assert.equal(expected.reader,reader);
  await assert.rejects(applyItemStatus({...input,command}));
  await assert.rejects(applyItemStatus({...input,expected:{...expected,token:"bad"}}));
  b.time(1000);assert.equal((await applyItemStatus({...input,expected})).state,"applied");
  assert.equal(await pendingItemStatus(input),null);assert.equal(b.calls.filter(r=>r.action==="item-status-append").length,1);
});
test("discard waits out original write window and refuses another unlocked identity",async()=>{
  const b=backend(),input=recovery(b),command=await createItemStatusClient(owner,b.fetcher,b.clock).prepare(draft,key());
  const unavailable={...input,fetcher:(async()=>{throw Error("offline");}) as typeof fetch};
  await assert.rejects(applyItemStatus({...unavailable,command}));const expected=(await pendingItemStatus(input))!;
  await assert.rejects(discardItemStatus({...input,expected}));
  await assert.rejects(pendingItemStatus({...input,principal:reader}));
  b.time(105);assert.equal((await discardItemStatus({...input,expected})).state,"absent");
  await assert.rejects(discardItemStatus({...input,expected}));await assert.rejects(applyItemStatus(input));
});

test("authenticated proxy forwards all item-status actions and rechecks session",async()=>{
  const b=backend(),client=createItemStatusClient(owner,b.fetcher,b.clock),command=await client.prepare(draft,key());
  const tenant="11111111-1111-4111-8111-111111111111";
  let reads=0,change=false;
  // The service intentionally omits browser credentials on its upstream request.
  const proxyBackend:typeof fetch=async(url,init)=>{
    assert.equal(init?.credentials,"omit");
    return Response.json(String(url).endsWith("view")?{at:100,fence,ownerPub:owner,status}:
      String(url).endsWith("state")?{at:100,state:"absent"}:{accepted:true});
  };
  const proxy=createMediaGroupService({origin:"https://acl.example",tenant,readers:[{principal:owner,apiKey:"private-key"}]},"https://site.example",
    async()=>{reads++;return change&&reads%2===0?reader:owner;},proxyBackend,b.clock);
  const request=(body:unknown)=>new Request("https://site.example/api/media/groups/item-status-view",{method:"POST",headers:{Origin:"https://site.example","Content-Type":"application/json"},body:JSON.stringify(body)});
  const {object,predicate,set,reader:recipient,payload}=command.body;
  for(const [action,body] of [["item-status-view",draft],["item-status-append",command.body],["item-status-state",{object,predicate,set,reader:recipient,payload}]] as const)
    assert.equal((await proxy(action,request(body))).status,200);
  assert.equal((await proxy("item-status-view",request({...draft,reader:"bad"}))).status,400);
  reads=0;change=true;assert.equal((await proxy("item-status-view",request(draft))).status,403);
});

test("status freshness is checked again after signing and invalid responses refuse",async()=>{
  const b=backend();let ticks=0;
  await assert.rejects(createItemStatusClient(owner,b.fetcher,()=>++ticks>1?105:100).prepare(draft,key()));
  const command=await createItemStatusClient(owner,b.fetcher,b.clock).prepare(draft,key());
  const absent:typeof fetch=async(url)=>Response.json(String(url).endsWith("append")?{accepted:true}:{at:100,state:"absent"});
  await assert.rejects(createItemStatusClient(owner,absent,b.clock).apply(command));
  const wrong:typeof fetch=async()=>new Response("{}");await assert.rejects(createItemStatusClient(owner,wrong,b.clock).apply(command));
});
