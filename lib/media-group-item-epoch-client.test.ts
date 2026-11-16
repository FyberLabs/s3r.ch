// HTTP, signing and encrypted journal contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import type {SeaPair} from "./identity/sea";
import {owner,reader,object,scope,plan} from "./media-group-item-epoch-fixture";
import {prepareGroupItemEpoch} from "./media-group-item-epoch-signing";
import {createItemEpochClient} from "./media-group-item-epoch-client";
import {applyItemEpoch,pendingItemEpoch,discardItemEpoch} from "./media-group-item-epoch-recovery";
import {createShareJournal} from "./media-share-journal";
import {createMediaGroupService} from "./media-group-service";
function backend(){
  let at=100,applied=false,lost=false,offline=false;
  const calls:{action:string;body:Record<string,unknown>}[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    const action=String(url).split("/").at(-1)!,body=JSON.parse(String(init?.body));calls.push({action,body});
    assert.equal(init?.credentials,"same-origin");assert.equal(init?.redirect,"error");assert.equal(init?.cache,"no-store");
    if(offline)throw Error("offline");
    if(action==="item-epoch-view")return Response.json({...plan,at});
    if(action==="item-epoch-state")return Response.json({at,state:applied?"applied":"absent"});
    assert.equal(action,"item-epoch-append");applied=true;if(lost)throw Error("lost reply");return Response.json({accepted:true});
  };
  return {fetcher,calls,clock:()=>at,time:(v:number)=>{at=v;},lose:()=>{lost=true;},offline:(v=true)=>{offline=v;},applied:()=>{applied=true;}};
}
const prepare=(b:ReturnType<typeof backend>)=>{
  const scalar=new Uint8Array(32);scalar[31]=1;
  return prepareGroupItemEpoch(object,scope,owner,"browser",scalar,b.fetcher,b.clock,new AbortController().signal);
};
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:owner,epriv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"} as SeaPair;
function recovery(b:ReturnType<typeof backend>){return {tenant:"11111111-1111-4111-8111-111111111111",principal:owner,pair,fetcher:b.fetcher,clock:b.clock,signal:new AbortController().signal,journal:createShareJournal(new IDBFactory(),"group-item-epoch")};}
test("atomic command is applied once without refreshing its plan or fence",async()=>{
  const b=backend(),command=await prepare(b),c=createItemEpochClient(owner,b.fetcher,b.clock);
  assert.equal((await c.apply(command)).state,"applied");b.time(1000);
  assert.equal((await c.apply(command)).state,"applied");
  assert.equal(b.calls.filter(c=>c.action==="item-epoch-view").length,1);
  assert.deepEqual(b.calls.filter(c=>c.action==="item-epoch-append").map(c=>c.body),[command.body]);
  assert.ok(b.calls.every(c=>!("plan" in c.body)&&!("ownerPub" in c.body)));
});
test("expired and future absent commands refuse append",async()=>{
  for(const at of [99,105]){const b=backend(),command=await prepare(b);b.time(at);
    await assert.rejects(createItemEpochClient(owner,b.fetcher,b.clock).apply(command));
    assert.equal(b.calls.filter(c=>c.action==="item-epoch-append").length,0);}
});
test("failed or malformed responses never clear an unconfirmed command",async()=>{
  const b=backend(),command=await prepare(b);assert.throws(()=>createItemEpochClient("bad"));
  for(const response of [()=>new Response("unavailable",{status:503}),()=>new Response("{}"),()=>Response.json({at:95,state:"applied"}),
      ()=>Response.json({at:100,state:"applied",extra:1}),()=>Response.json({text:"a".repeat(9000)})]){
    await assert.rejects(createItemEpochClient(owner,async()=>response(),b.clock).apply(command));
  }
  const absent:typeof fetch=async(url)=>Response.json(String(url).endsWith("append")?{accepted:true}:{at:100,state:"absent"});
  await assert.rejects(createItemEpochClient(owner,absent,b.clock).apply(command));
  const abort=new AbortController();abort.abort();await assert.rejects(createItemEpochClient(owner,b.fetcher,b.clock).apply(command,abort.signal));
});
test("lost append reply retains encrypted draft; recovery confirms it without another append",async()=>{
  const b=backend(),input=recovery(b),command=await prepare(b);
  assert.equal(await pendingItemEpoch(input),null);b.lose();await assert.rejects(applyItemEpoch({...input,command}));
  const entry=await input.journal.read(input.signal);assert.ok(entry);assert.ok(!new TextDecoder().decode(entry.encrypted).includes(command.body.fence as string));
  const expected=(await pendingItemEpoch(input))!;assert.equal(expected.epoch,2);
  await assert.rejects(applyItemEpoch({...input,command}));
  await assert.rejects(applyItemEpoch({...input,expected:{...expected,token:"bad"}}));
  b.time(1000);assert.equal((await applyItemEpoch({...input,expected})).state,"applied");
  assert.equal(await pendingItemEpoch(input),null);
  assert.equal(b.calls.filter(c=>c.action==="item-epoch-append").length,1);
  assert.equal(b.calls.filter(c=>c.action==="item-epoch-view").length,1);
});
test("discard refuses a live original fence and a changed identity",async()=>{
  const b=backend(),input=recovery(b),command=await prepare(b);b.offline();
  await assert.rejects(applyItemEpoch({...input,command}));b.offline(false);
  const expected=(await pendingItemEpoch(input))!;
  await assert.rejects(discardItemEpoch({...input,expected}));
  await assert.rejects(pendingItemEpoch({...input,principal:reader}));
  await assert.rejects(discardItemEpoch({...input,expected:{...expected,epoch:3}}));
  b.time(105);assert.equal((await discardItemEpoch({...input,expected})).state,"absent");
  await assert.rejects(discardItemEpoch({...input,expected}));await assert.rejects(applyItemEpoch(input));
});
test("confirmed drafts can be discarded and cancellation preserves pending storage",async()=>{
  const b=backend(),input=recovery(b),command=await prepare(b);b.offline();await assert.rejects(applyItemEpoch({...input,command}));
  const expected=(await pendingItemEpoch(input))!;const controller=new AbortController();controller.abort();
  await assert.rejects(pendingItemEpoch({...input,signal:controller.signal}));
  b.offline(false);b.applied();assert.equal((await discardItemEpoch({...input,expected})).state,"applied");
  assert.equal(await pendingItemEpoch(input),null);
});
test("authenticated proxy forwards exact atomic payloads and rechecks the session",async()=>{
  const b=backend(),command=await prepare(b);let reads=0,change=false;
  const upstream:typeof fetch=async(url,init)=>{
    assert.equal(init?.credentials,"omit");assert.equal(init?.redirect,"error");
    const sent=JSON.parse(String(init?.body));assert.ok(!("plan" in sent));
    if(String(url).endsWith("append"))assert.deepEqual(sent,command.body);
    else assert.deepEqual(sent,{object,...scope,payload:command.body.payload});
    return Response.json(String(url).endsWith("append")?{accepted:true}:{at:100,state:"applied"});
  };
  const proxy=createMediaGroupService({origin:"https://acl.example",tenant:"11111111-1111-4111-8111-111111111111",readers:[{principal:owner,apiKey:"private-key"}]},
    "https://site.example",async()=>{reads++;return change&&reads%2===0?reader:owner;},upstream,b.clock);
  const request=(body:unknown)=>new Request("https://site.example/api/media/groups/item-epoch-append",{method:"POST",headers:{Origin:"https://site.example","Content-Type":"application/json"},body:JSON.stringify(body)});
  for(const [action,body] of [["item-epoch-append",command.body],["item-epoch-state",{object,...scope,payload:command.body.payload}]] as const)
    assert.equal((await proxy(action,request(body))).status,200);
  assert.equal((await proxy("item-epoch-append",request(command))).status,400);
  reads=0;change=true;assert.equal((await proxy("item-epoch-append",request(command.body))).status,403);
});
