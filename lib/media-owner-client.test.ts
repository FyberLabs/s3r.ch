// Browser HTTP/signature contracts: executed in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { signPrivateMediaGrant, signPrivateMediaEpoch } from "sociacl-ids/private-media";
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
  for(const result of [null,[],{...view,owner:other},{...view,at:99},{...view,fence:"bad"},
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
