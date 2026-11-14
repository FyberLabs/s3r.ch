// Browser HTTP/signature contracts: executed in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { signPrivateMediaGrant, signPrivateMediaEpoch, signPrivateMediaFinalization } from "sociacl-ids/private-media";
import { createPrivateMediaOwner, PrivateMediaConflict } from "./media-owner-client";
import type { ItemReaderWrap } from "sociacl-ids";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const key=()=>{const k=new Uint8Array(32);k[31]=1;return k;};
const view={at:100,fence:"a".repeat(64),snapshot:{entries:[]},objectVersion:0,owner,bindings:{[owner]:{pub:owner,epub:owner,head:0}}};
const grant={object,owner,accessor:owner,from:0,until:200000,stated:1,epoch:1,grantRevision:1,itemCiphertextDigest:"b".repeat(64)};
const epoch={object,previousEpoch:0,epoch:1,deviceId:"browser",keyCommitment:"c".repeat(64),settleWindowMs:3600000};
const status={object,epoch:1,revisionId:"b".repeat(64),accessor:owner,grantRevision:1,stated:1,signedAt:100000,maxAgeMs:60000,
  zookie:{object,objectVersion:3,snapshotHash:"c".repeat(64)}};
const draft={at:100,fence:view.fence,ownerPub:owner,status};
const wrap:ItemReaderWrap={object,epoch:1,revisionId:"a".repeat(64),scope:"item-dek",target:"reader-epub",targetId:owner,wrappedKey:"00"};
const reference={sha256:"b".repeat(64),length:64};
const action=(url:RequestInfo | URL)=>String(url).split("/").at(-1);
test("grant signs the protected current key and exact fence without sending secrets",async()=>{
  const scalar=key(), expected=signPrivateMediaGrant(grant,key(),owner);let calls=0;
  const client=createPrivateMediaOwner(async(url,init)=>{
    calls++;assert.equal(init?.credentials,"same-origin");assert.equal(init?.redirect,"error");
    if(action(url)==="view"){scalar.fill(0);return Response.json(view,{headers:{"Content-Encoding":"br"}});}
    assert.deepEqual(JSON.parse(String(init?.body)),{object,at:100,fence:view.fence,operation:"grant",payload:expected});
    return Response.json({accepted:true});
  },()=>100);
  await client.grant(object,owner,grant,scalar);assert.equal(calls,2);assert.deepEqual(scalar,new Uint8Array(32));
});
test("epoch and status use shared producers with current protected state",async()=>{
  const document=signPrivateMediaEpoch(epoch,view.snapshot,key(),owner);
  const finalization={object,epoch:1,previousEpoch:0,revisionId:document.manifest.revisionId,
    candidateRevisionIds:[document.manifest.revisionId],previousFinalizationId:""};
  const writes:Record<string,unknown>[]=[];
  const client=createPrivateMediaOwner(async(url,init)=>{
    if(action(url)==="view")return Response.json(view);
    if(action(url)==="status-view")return Response.json(draft);
    writes.push(JSON.parse(String(init?.body)));return Response.json({accepted:true});
  },()=>100);
  assert.deepEqual(await client.epoch(object,owner,epoch,finalization,key()),{object,epoch:1,revisionId:document.manifest.revisionId});
  await client.status(object,owner,key());
  assert.deepEqual(writes.map(w=>w.operation),["epoch","status"]);
  assert.ok(JSON.stringify(writes).includes('"signature"'));
  await assert.rejects(client.epoch(object,owner,epoch,{...finalization,revisionId:"0".repeat(64),candidateRevisionIds:["0".repeat(64)]},key()));
});
test("conflicts and lost responses never replay a signed operation",async()=>{
  for(const failure of [409,500]){
    let calls=0;const client=createPrivateMediaOwner(async()=>++calls===1?Response.json(view):new Response("private detail",{status:failure}),()=>100);
    await assert.rejects(client.grant(object,owner,grant,key()),failure===409?PrivateMediaConflict:Error);assert.equal(calls,2);
  }
  let calls=0;const client=createPrivateMediaOwner(async()=>{if(++calls===1)return Response.json(view);throw Error("lost");},()=>100);
  await assert.rejects(client.grant(object,owner,grant,key()));assert.equal(calls,2);
});
test("wrong session owner, rotated keys, expired views and malformed responses refuse before writes",async()=>{
  for(const result of [null,[],{...view,owner:other},{...view,at:-1},{...view,fence:"bad"},
    {...view,bindings:[]},{...view,bindings:{}},{...view,bindings:{[owner]:{pub:other}}}]){
    let calls=0;const client=createPrivateMediaOwner(async()=>{calls++;return Response.json(result);},()=>100);
    await assert.rejects(client.grant(object,owner,grant,key()));assert.equal(calls,1);
  }
  const client=createPrivateMediaOwner(async()=>Response.json(view),()=>100);
  await assert.rejects(client.grant("bad",owner,grant,key()));
  await assert.rejects(client.grant(object,owner,grant,new Uint8Array(1)));
  await assert.rejects(client.grant(object,owner,grant,key(),AbortSignal.abort()));
  await assert.rejects(client.grant(object,owner,{...grant,owner:other},key()));
  const refused=createPrivateMediaOwner(async(url)=>action(url)==="view"?Response.json(view):Response.json({accepted:false}),()=>100);
  await assert.rejects(refused.grant(object,owner,grant,key()));
});
test("status drafts must match recipient and clock before signing",async()=>{
  for(const result of [{...draft,ownerPub:"bad"},{...draft,status:{...status,accessor:other}},
    {...draft,status:{...status,signedAt:100001}}]){
    let calls=0;const client=createPrivateMediaOwner(async()=>{calls++;return Response.json(result);},()=>100);
    await assert.rejects(client.status(object,owner,key()));assert.equal(calls,1);
  }
  await assert.rejects(createPrivateMediaOwner().status("bad",owner,key()));
});
test("private publication hashes the encrypted record and preserves the reference privately",async()=>{
  let calls=0;
  const client=createPrivateMediaOwner(async(url,init)=>{
    calls++;if(action(url)==="view")return Response.json(view);
    assert.equal(action(url),"publish-wrap");const body=JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(atob(body.wrapBase64)),{wrap,reference});
    assert.equal(body.metadata.reader,owner);assert.equal(body.metadata.readerEpub,owner);
    assert.equal(body.metadata.itemDigest,reference.sha256);
    return Response.json({record:body.metadata.digest,digest:body.metadata.digest});
  },()=>100);
  assert.match(await client.publishWrap(object,owner,owner,wrap,reference),/^[a-f0-9]{64}$/);assert.equal(calls,2);
  await assert.rejects(client.publishWrap(object,owner,owner,wrap,{...reference,sha256:"bad"}));
  await assert.rejects(client.publishWrap(object,owner,owner,{...wrap,wrappedKey:"00".repeat(40000)},reference));
  const bad=createPrivateMediaOwner(async(url)=>action(url)==="view"?Response.json(view):Response.json({digest:"f".repeat(64),record:"f".repeat(64)}),()=>100);
  await assert.rejects(bad.publishWrap(object,owner,owner,wrap,reference));
});

test("source timestamps survive clock skew and second boundaries; delayed views expire",async()=>{
  for(const start of [0,99.9,1000000]) {
    let now=start, calls=0;
    const client=createPrivateMediaOwner(async(url,init)=>{
      calls++;
      if(action(url)==="view"){now+=0.2;return Response.json(view);}
      assert.equal(JSON.parse(String(init?.body)).at,100);
      return Response.json({accepted:true});
    },()=>now);
    await client.grant(object,owner,grant,key());assert.equal(calls,2);
  }
  for(const elapsed of [4,-1,NaN]) {
    let now=0,calls=0;
    const client=createPrivateMediaOwner(async()=>{calls++;now=elapsed;return Response.json(view);},()=>now);
    await assert.rejects(client.grant(object,owner,grant,key()),PrivateMediaConflict);
    assert.equal(calls,1);
  }
});

test("catalog validates source scope, pagination and monotonic freshness",async()=>{
  const result={at:100,objects:[object],nextPage:1,principal:owner};
  const client=createPrivateMediaOwner(async()=>Response.json(result),()=>10);
  assert.deepEqual(await client.catalog(0),result);
  await assert.rejects(client.catalog(16));
  for(const principal of [other,"invalid",null])await assert.rejects(createPrivateMediaOwner(async()=>Response.json({...result,principal})).catalog(0));
  for(const elapsed of [4,-1,NaN]) {
    let now=0;const delayed=createPrivateMediaOwner(async()=>{now=elapsed;return Response.json(result);},()=>now);
    await assert.rejects(delayed.catalog(0),PrivateMediaConflict);
  }
  const aborted=new AbortController();aborted.abort();await assert.rejects(client.catalog(0,aborted.signal));
});

test("recipients are read-only and cancellation signs only the bound zero-stated draft",async()=>{
  const entry={accessor:other,grantRevision:1,stated:1,from:0,until:1,scope:"direct",setId:"",hamState:0};
  const cancel={...grant,accessor:other,stated:0,grantRevision:2};let writes=0;
  const client=createPrivateMediaOwner(async(url,init)=>{
    if(String(url).endsWith("/view"))return Response.json({...view,snapshot:{entries:[entry]}});
    if(String(url).endsWith("/cancel-view"))return Response.json({at:100,fence:view.fence,ownerPub:owner,grant:cancel});
    writes++;const body=JSON.parse(String(init?.body));assert.equal(body.operation,"grant");assert.deepEqual(body.payload.claims,cancel);
    return Response.json({accepted:true});
  },()=>0);
  assert.deepEqual(await client.recipients(object,owner),[other]);assert.equal(writes,0);
  await client.cancel(object,other,key());assert.equal(writes,1);
  for(const invalid of [{...cancel,stated:1},{...cancel,accessor:owner},{...cancel,object:object.replace(/1/g,"2")},
    {...cancel,grantRevision:1}]) {
    const bad=createPrivateMediaOwner(async()=>Response.json({at:100,fence:view.fence,ownerPub:owner,grant:invalid}),()=>0);
    await assert.rejects(bad.cancel(object,other,key()));
  }
  await assert.rejects(client.cancel("bad",other,key()));await assert.rejects(client.cancel(object,"bad",key()));
  await assert.rejects(createPrivateMediaOwner(async()=>Response.json({at:100,fence:view.fence,ownerPub:"bad",grant:cancel}),()=>0).cancel(object,other,key()));
  for(const entries of [[{...entry,accessor:"bad"}],[{...entry,scope:"group"}],[{...entry,stated:2}],
    [{...entry,grantRevision:0}],[{...entry,from:-1}],[{...entry,until:0}],[{...entry,hamState:1}],
    [{...entry,setId:"set"}],[entry,entry],new Array(65).fill(entry)]) {
    await assert.rejects(createPrivateMediaOwner(async()=>Response.json({...view,snapshot:{entries}}),()=>0).recipients(object,owner));
  }
  const empty=createPrivateMediaOwner(async()=>Response.json({...view,snapshot:{entries:[{...entry,stated:0}]}}),()=>0);
  assert.deepEqual(await empty.recipients(object,owner),[]);
});

test("allocation snapshots only signed ownership and confirms a fresh protected object view",async()=>{
  const record={object,owner,issuedAt:100,sig:"signed"};const calls:string[]=[];
  const client=createPrivateMediaOwner(async(url,init)=>{
    calls.push(action(url)!);
    if(action(url)==="allocate"){
      assert.deepEqual(JSON.parse(String(init?.body)),record);
      return Response.json({object,accepted:true});
    }
    return Response.json(view);
  },()=>100);
  assert.deepEqual(await client.allocate({...record,secret:"never sent"} as typeof record),{object});
  assert.deepEqual(calls,["allocate","view"]);
  await assert.rejects(client.allocate({...record,object:"bad"}));
  for(const response of [{object:"wrong",accepted:true},{object,accepted:false}]){
    await assert.rejects(createPrivateMediaOwner(async()=>Response.json(response)).allocate(record));
  }
  await assert.rejects(createPrivateMediaOwner(async(url)=>action(url)==="allocate" ? Response.json({object,accepted:true}) : new Response(null,{status:403})).allocate(record));
});

test("initial epoch derives its finalization from the fresh protected snapshot", async () => {
  const snapshot = { entries: [{ accessor: owner, grantRevision: 1, stated: 1, from: 0, until: 200000,
    scope: "direct", setId: "", hamState: 0 }] };
  const document = signPrivateMediaEpoch(epoch, snapshot, key(), owner), revisionId = document.manifest.revisionId;
  const finalization = signPrivateMediaFinalization({ object, previousEpoch: 0, epoch: 1, revisionId,
    candidateRevisionIds: [revisionId], previousFinalizationId: "" }, key(), owner);
  const input = { deviceId: "browser", keyCommitment: "c".repeat(64), settleWindowMs: 3600000 };
  let calls = 0;
  const client = createPrivateMediaOwner(async (url, init) => {
    calls++;
    if (action(url) === "view") { input.keyCommitment = "d".repeat(64); return Response.json({ ...view, snapshot }); }
    assert.deepEqual(JSON.parse(String(init?.body)), { object, at: 100, fence: view.fence, operation: "epoch", payload: { document, finalization } });
    return Response.json({ accepted: true });
  }, () => 100);
  assert.deepEqual(await client.initialEpoch(object, owner, input, key()), { object, epoch: 1, revisionId });
  assert.equal(calls, 2);
});

test("initial epoch refuses caller finalization fields and never retries a conflict", async () => {
  const input = { deviceId: "browser", keyCommitment: "c".repeat(64), settleWindowMs: 3600000 };
  let calls = 0;
  const client = createPrivateMediaOwner(async (url) => {
    calls++; return action(url) === "view" ? Response.json(view) : new Response(null, { status: 409 });
  }, () => 100);
  for (const extra of [{ epoch: 2 }, { previousEpoch: 1 }, { revisionId: "a".repeat(64) }, { snapshot: { entries: [] } }])
    await assert.rejects(client.initialEpoch(object, owner, { ...input, ...extra }, key()));
  assert.equal(calls, 0);
  await assert.rejects(client.initialEpoch(object, owner, input, key()), PrivateMediaConflict);
  assert.equal(calls, 2);
});

test("recovery preparation and probes refuse foreign scopes, keys and malformed classifications",async()=>{
  const signal=new AbortController().signal;
  const client=createPrivateMediaOwner(async()=>Response.json(view),()=>100);
  await assert.rejects(client.prepareUploadGrant(object,owner,{...grant,accessor:other},key(),signal));
  await assert.rejects(client.prepareUploadGrant(object,owner,{...grant,grantRevision:2},key(),signal));
  const wrong=createPrivateMediaOwner(async()=>Response.json({...view,bindings:{[owner]:{pub:owner,epub:"bad"}}}),()=>100);
  await assert.rejects(wrong.prepareUploadEpoch(object,owner,"c".repeat(64),key(),signal));
  for(const result of [{at:1,state:"allowed"},{at:-1,state:"applied"},{at:1,state:"applied",fence:view.fence}])
    await assert.rejects(createPrivateMediaOwner(async()=>Response.json(result),()=>100).uploadState(object,"epoch",{},signal));
  await assert.rejects(client.uploadState("bad","epoch",{},signal));
});

test("deletion preparation signs once and explicit retry sends the identical proof",async()=>{
  const tenant="11111111-1111-4111-8111-111111111111";
  const claims={tenant,object,owner,objectVersion:3,fence:view.fence,issuedAt:100000,expiresAt:160000};
  let drafts=0;const writes:unknown[]=[];
  const client=createPrivateMediaOwner(async(url,init)=>{
    if(action(url)==="delete-view"){drafts++;return Response.json({at:100,ownerPub:owner,claims});}
    writes.push(JSON.parse(String(init?.body)));
    if(writes.length===1)throw Error("lost response");
    return Response.json({accepted:true,command:"f".repeat(64),cleanup:"pending"});
  },()=>100);
  const intent=await client.prepareDeletion(tenant,object,owner,key());assert.equal(writes.length,0);
  await assert.rejects(client.submitDeletion(intent));
  assert.deepEqual(await client.submitDeletion(intent),{command:"f".repeat(64),cleanup:"pending"});
  assert.equal(drafts,1);assert.deepEqual(writes[0],writes[1]);
  assert.equal((writes[0] as {proof:{signature:string}}).proof.signature.length,128);
});
test("deletion refuses stale or foreign drafts and never treats pending cleanup as completed",async()=>{
  const tenant="11111111-1111-4111-8111-111111111111";
  const claims={tenant,object,owner,objectVersion:1,fence:view.fence,issuedAt:100000,expiresAt:160000};
  for(const draft of [{at:100,ownerPub:other,claims},{at:100,ownerPub:owner,claims:{...claims,object:"bad"}}]){
    let calls=0;const client=createPrivateMediaOwner(async()=>{calls++;return Response.json(draft);},()=>100);
    await assert.rejects(client.prepareDeletion(tenant,object,owner,key()));assert.equal(calls,1);
  }
  let ticks=0;const stale=createPrivateMediaOwner(async()=>Response.json({at:100,ownerPub:owner,claims}),()=>ticks++?105:100);
  await assert.rejects(stale.prepareDeletion(tenant,object,owner,key()),PrivateMediaConflict);
  const client=createPrivateMediaOwner(async(url)=>action(url)==="delete-view"?Response.json({at:100,ownerPub:owner,claims}):Response.json({accepted:true,command:"f".repeat(64),cleanup:"complete"}),()=>100);
  const intent=await client.prepareDeletion(tenant,object,owner,key());await assert.rejects(client.submitDeletion(intent));
  await assert.rejects(client.prepareDeletion(tenant,"bad",owner,key()));
});

test("cleanup accepts only completion of the accepted command and never retries",async()=>{
  const command="a".repeat(64);let calls=0;
  const client=createPrivateMediaOwner(async(url,init)=>{calls++;assert.equal(action(url),"cleanup");
    assert.deepEqual(JSON.parse(String(init?.body)),{object});return Response.json({accepted:true,command,cleanup:"complete"});});
  assert.deepEqual(await client.cleanup(object,command),{command,cleanup:"complete"});assert.equal(calls,1);
  await assert.rejects(client.cleanup("bad",command));await assert.rejects(client.cleanup(object,"bad"));assert.equal(calls,1);
  for(const reply of [{accepted:true,command,cleanup:"pending"},{accepted:true,command:"b".repeat(64),cleanup:"complete"},{accepted:false,command,cleanup:"complete"}]) {
    let requests=0;const invalid=createPrivateMediaOwner(async()=>{requests++;return Response.json(reply);});
    await assert.rejects(invalid.cleanup(object,command));assert.equal(requests,1);
  }
});

test("cleanup catalog binds owner, exact commands, pages and response age",async()=>{
  const result={at:100,objects:[{object,command:"a".repeat(64)}],nextPage:1,principal:owner};
  const client=createPrivateMediaOwner(async(url,init)=>{
    assert.equal(action(url),"cleanup-catalog");assert.deepEqual(JSON.parse(String(init?.body)),{page:0});return Response.json(result);
  },()=>100);
  assert.deepEqual(await client.cleanupCatalog(0),result);
  await assert.rejects(client.cleanupCatalog(16));
  for(const bad of [null,{...result,principal:other},{...result,nextPage:null},
    {...result,objects:[{object,command:"bad"}]},{...result,objects:[result.objects[0],result.objects[0]]},
    {...result,objects:[{object,command:"a".repeat(64),owner}]},{...result,objects:["bad"]}])
    await assert.rejects(createPrivateMediaOwner(async()=>Response.json(bad),()=>100).cleanupCatalog(0));
  let now=100;
  await assert.rejects(createPrivateMediaOwner(async()=>{now=104;return Response.json(result);},()=>now).cleanupCatalog(0),PrivateMediaConflict);
});
