// Signing and HTTP contracts execute in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createGroupKeyClient,parseSignedGroupKeyCommand} from "./media-group-key-client";
import {groupKeySnapshotId} from "sociacl-ids/private-media";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const set="set_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set};
const snapshot={predicate:scope.predicate,setId:set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:other,ownerIdentityHead:0,members:[]};
const config={owner,setId:set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:"1".repeat(128)};
const view={at:100,fence:"a".repeat(64),snapshot,config,previousEpoch:0,previousFinalizationId:""};
const scalar=new Uint8Array(32);scalar[31]=1;
const groupKey=new Uint8Array(32);groupKey[31]=7;
const client=(fetcher:typeof fetch)=>createGroupKeyClient(owner,fetcher,()=>100);

test("fresh preparation signs one group snapshot without sending secret bytes",async()=>{
  const keyBefore=groupKey.slice(),scalarBefore=scalar.slice();let count=0;
  const api=client(async(url,init)=>{
    count++;assert.equal(String(url),"/api/media/groups/key-view");
    assert.deepEqual(JSON.parse(String(init?.body)),scope);assert.equal(init?.credentials,"same-origin");
    assert.equal(init?.redirect,"error");assert.equal(init?.cache,"no-store");return Response.json(view);
  });
  const result=await api.prepare(scope,"device",groupKey,scalar);
  assert.equal(count,1);assert.deepEqual(groupKey,keyBefore);assert.deepEqual(scalar,scalarBefore);
  const command=result.command as {document:{manifest:{aclSnapshot:string;keyCommitment:string;signature:string};snapshot:unknown};finalization:{signature:string}};
  assert.equal(command.document.manifest.aclSnapshot,groupKeySnapshotId(snapshot));
  assert.deepEqual(command.document.snapshot,snapshot);
  assert.match(command.document.manifest.keyCommitment,/^[a-f0-9]{64}$/);
  assert.match(command.document.manifest.signature,/^[a-f0-9]{128}$/);
  assert.match(command.finalization.signature,/^[a-f0-9]{128}$/);
  assert.throws(()=>parseSignedGroupKeyCommand(result,other));
});

test("lost append retries the retained signature after fresh exact-state reconciliation",async()=>{
  const prepared=await client(async()=>Response.json(view)).prepare(scope,"device",groupKey,scalar);
  const writes:unknown[]=[];let applied=false,attempts=0;
  const api=client(async(url,init)=>{
    if(String(url).endsWith("key-state")){
      assert.deepEqual(JSON.parse(String(init?.body)),prepared);
      return Response.json({at:100,state:applied?"applied":"absent",fence:view.fence});
    }
    writes.push(JSON.parse(String(init?.body)));if(writes.length===1)throw Error("lost reply");
    applied=true;return Response.json({accepted:true});
  });
  await assert.rejects(api.apply(prepared,undefined,async at=>{assert.equal(at,100);attempts++;}));
  await api.apply(prepared,undefined,async()=>{attempts++;});
  assert.deepEqual(writes[0],writes[1]);assert.equal(attempts,2);
  await api.apply(prepared,undefined,async()=>{throw Error("must not append");});
  assert.equal(writes.length,2);assert.equal((await api.state(prepared)).state,"applied");
});

test("invalid keys, changed current signer, stale views and interruption refuse",async()=>{
  assert.throws(()=>createGroupKeyClient("bad"));
  const api=client(async()=>Response.json(view));
  for(const key of [new Uint8Array(31),null]){
    await assert.rejects(api.prepare(scope,"device",key as Uint8Array,scalar));
    await assert.rejects(api.prepare(scope,"device",groupKey,key as Uint8Array));
  }
  for(const changed of [{...view,at:90},{...view,snapshot:{...snapshot,ownerSigningPub:other}},{...view,previousEpoch:1}])
    await assert.rejects(client(async()=>Response.json(changed)).prepare(scope,"device",groupKey,scalar));
  const controller=new AbortController();controller.abort();let fetched=false;
  await assert.rejects(client(async()=>{fetched=true;return Response.json(view);}).prepare(scope,"device",groupKey,scalar,controller.signal));
  assert.equal(fetched,false);assert.equal(groupKey[31],7);assert.equal(scalar[31],1);
  const prepared=await api.prepare(scope,"device",groupKey,scalar);let appended=false;
  const interrupted=new AbortController();
  await assert.rejects(client(async url=>{
    if(String(url).endsWith("key-append"))appended=true;
    return Response.json({at:100,state:"absent",fence:view.fence});
  }).apply(prepared,interrupted.signal,async()=>{interrupted.abort();}));
  assert.equal(appended,false);
});

test("bad transport and malformed responses refuse without revealing secrets",async()=>{
  for(const response of [new Response("secret",{status:403}),new Response("{}",{headers:{"content-type":"text/plain"}}),Response.json({}),Response.json({...view,padding:"x".repeat(73729)})])
    await assert.rejects(client(async()=>response).prepare(scope,"device",groupKey,scalar));
});
