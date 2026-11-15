// Native-compatible signing and HTTP contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createGroupCommandClient,parseSignedGroupCommand} from "./media-group-client";
import {parseForumAuthority} from "./identity/forum-authority-records";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const key=()=>{const value=new Uint8Array(32);value[31]=1;return value;};
const fence="a".repeat(64);
function backend() {
  const requests:{action:string;body:Record<string,unknown>}[]=[];
  let applied=false,now=100,fail=false;
  const fetcher:typeof fetch=async(url,init)=>{
    const action=String(url).split("/").at(-1)!,body=JSON.parse(String(init?.body));requests.push({action,body});
    assert.equal(init?.credentials,"same-origin");assert.equal(init?.redirect,"error");
    for(const field of ["priv","epriv","scalar","apiKey"])assert.equal(Object.hasOwn(body,field),false);
    if(fail)return new Response("unavailable",{status:503});
    if(action==="create-view")return Response.json({at:now,fence,context:{owner,ownerPub:owner,predicate:scope.predicate,setId:scope.set}});
    if(action==="member-view")return Response.json({at:now,fence,signerPub:owner,draft:{...body,setOwner:owner,hamState:1,issuedAt:now,cancels:[]}});
    if(action.endsWith("state"))return Response.json({at:now,state:applied?"applied":"absent",...(action==="member-state"||!applied?{fence}:{})});
    applied=true;return Response.json({accepted:true});
  };
  return {requests,fetcher,clock:()=>now,setTime:(value:number)=>{now=value;},setFailure:(value:boolean)=>{fail=value;},setApplied:(value:boolean)=>{applied=value;}};
}
test("creation signs current context and exact retry never signs or writes again",async()=>{
  const server=backend(),client=createGroupCommandClient(owner,server.fetcher,server.clock);
  const scalar=key(),command=await client.prepareCreate(object,scope,3600000,scalar);
  assert.equal(scalar[31],1);assert.equal(command.kind,"create");
  assert.equal((command.body.config as {signature:string}).signature.length,128);
  await client.apply(command);assert.equal((await client.state(command)).state,"applied");
  await client.apply(command);assert.equal(server.requests.filter(row=>row.action==="create").length,1);
  assert.deepEqual(server.requests.find(row=>row.action==="create")!.body.config,command.body.config);
  assert.equal(server.requests.filter(row=>row.action==="create-view").length,1);
});
test("member commands bind current party and preserve the exact signed row",async()=>{
  const server=backend(),client=createGroupCommandClient(owner,server.fetcher,server.clock);
  for(const [role,member,stated] of [["set",other,1],["member",owner,0]] as const){
    server.setApplied(false);
    const command=await client.prepareMember(scope,member,role,stated,key());
    const row=command.body.row as {record:{sig:string}};
    const parsed=parseForumAuthority("membership",row.record);assert.ok(parsed);
    assert.ok(verifyForumKeySignature(owner,row.record.sig,parsed.bytes));
    await client.apply(command);
    assert.deepEqual(server.requests.filter(row=>row.action==="member-append").at(-1)!.body.row,row);
    await client.apply(command);
  }
  assert.equal(server.requests.filter(row=>row.action==="member-append").length,2);
});
test("expired member commands refuse replacement signing and retain exact recovery",async()=>{
  const server=backend(),client=createGroupCommandClient(owner,server.fetcher,server.clock);
  const command=await client.prepareMember(scope,other,"set",1,key());
  server.setTime(105);await assert.rejects(client.apply(command));
  assert.equal(server.requests.filter(row=>row.action==="member-append").length,0);
  assert.equal(server.requests.filter(row=>row.action==="member-view").length,1);
  server.setApplied(true);await client.apply(command);
  assert.equal(server.requests.filter(row=>row.action==="member-append").length,0);
});
test("malformed keys, commands, contexts and failed transport refuse",async()=>{
  const server=backend(),client=createGroupCommandClient(owner,server.fetcher,server.clock);
  assert.throws(()=>createGroupCommandClient("bad"));
  for(const raw of [null,{}, {kind:"other",body:{}},{"kind,body":{}},{kind:"create",body:{},extra:1}])assert.throws(()=>parseSignedGroupCommand(raw,owner));
  await assert.rejects(client.prepareCreate(object,scope,1,key()));
  await assert.rejects(client.prepareCreate(object,scope,3600000,new Uint8Array(1)));
  await assert.rejects(client.prepareMember(scope,other,"member",1,key()));
  const wrong=new Uint8Array(32);wrong[31]=2;
  await assert.rejects(client.prepareCreate(object,scope,3600000,wrong));
  const abort=new AbortController();abort.abort();await assert.rejects(client.prepareCreate(object,scope,3600000,key(),abort.signal));
  server.setFailure(true);await assert.rejects(client.prepareCreate(object,scope,3600000,key()));
  const bad=createGroupCommandClient(owner,async()=>new Response("{}"),()=>100);
  await assert.rejects(bad.prepareCreate(object,scope,3600000,key()));
});
test("inputs and scalar are copied before asynchronous preparation",async()=>{
  const server=backend();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const client=createGroupCommandClient(owner,async(...args)=>{await gate;return server.fetcher(...args);},server.clock);
  const selected={...scope},scalar=key();const pending=client.prepareCreate(object,selected,3600000,scalar);
  scalar.fill(0);selected.set="changed";release();
  const command=await pending;assert.equal(command.body.set,scope.set);
  const held=structuredClone(command);let unblock!:()=>void;const wait=new Promise<void>(resolve=>{unblock=resolve;});
  const applying=createGroupCommandClient(owner,async(...args)=>{await wait;return server.fetcher(...args);},server.clock).apply(held);
  held.body.set="changed";unblock();await applying;
  assert.equal(server.requests.at(-1)!.body.set,scope.set);
});
