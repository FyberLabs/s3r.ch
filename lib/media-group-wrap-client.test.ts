// Cryptographic and HTTP contracts execute in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {groupKeySnapshotId} from "sociacl-ids/private-media";
import {createGroupWrapClient,parseGroupWrapBundle} from "./media-group-wrap-client";
import {shareDigest} from "./media-share-journal";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const reader="YP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Y.eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk";
const epub="EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c";
const epriv="6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8";
const set="set_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set};
const snapshot={predicate:scope.predicate,setId:set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:owner,ownerIdentityHead:0,
  members:[{accessor:reader,stated:1,hamState:1,signingPub:reader,encryptionPub:epub,identityHead:0}]};
const secret=new Uint8Array(32).fill(7);
async function fixture(){
  const manifest={object:set,previousEpoch:0,epoch:1,deviceId:"device",revisionId:"a".repeat(64),keyCommitment:await shareDigest(secret),
    settleWindowMs:3600000,aclSnapshot:groupKeySnapshotId(snapshot),signature:"1".repeat(128)};
  let view={at:100,fence:"f".repeat(64),snapshot,manifest};const writes:Record<string,unknown>[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('wrap-view'))return Response.json(view);
    const body=JSON.parse(String(init?.body));writes.push(body);
    return Response.json({digest:body.metadata.digest});
  };
  const client=createGroupWrapClient(owner,fetcher,()=>100);
  return {manifest,client,writes,setView:(value:typeof view)=>{view=value;},view};
}
test("prepared group wraps replay identical ciphertext and open only verified current keys",async()=>{
  const f=await fixture(),bundle=await f.client.prepare(scope,secret);
  assert.deepEqual(secret,new Uint8Array(32).fill(7));
  assert.equal(bundle.wraps.length,1);assert.equal(bundle.wraps[0].metadata.reader,reader);
  await f.client.publish(bundle,0);await f.client.publish(bundle,0);
  assert.deepEqual(f.writes[0],f.writes[1]);assert.equal(f.writes[0].payload,bundle.wraps[0].payload);
  const response={payload:bundle.wraps[0].payload,predicate:scope.predicate,set_id:set,epoch:1,revision_id:f.manifest.revisionId,
    reader_epub:epub,key_commitment:f.manifest.keyCommitment,expires_at:102};
  const recipient=createGroupWrapClient(reader,async()=>Response.json(response),()=>100);
  const opened=await recipient.open(scope,epriv,epub);assert.deepEqual(opened,secret);opened.fill(0);
  await assert.rejects(recipient.open(scope,epriv,owner));
  await assert.rejects(createGroupWrapClient(reader,async()=>Response.json({...response,key_commitment:'b'.repeat(64)}),()=>100).open(scope,epriv,epub));
  await assert.rejects(createGroupWrapClient(reader,async()=>Response.json({...response,payload:btoa('{}')}),()=>100).open(scope,epriv,epub));
});
test("saved wrap corruption and changed authority refuse without replacement publication",async()=>{
  const f=await fixture(),bundle=await f.client.prepare(scope,secret);
  for(const value of [null,{...bundle,extra:1},{...bundle,wraps:[]},{...bundle,epoch:0},
    {...bundle,wraps:[bundle.wraps[0],bundle.wraps[0]]},
    {...bundle,wraps:[{...bundle.wraps[0],payload:btoa('{}')}]},
    {...bundle,wraps:[{...bundle.wraps[0],metadata:{...bundle.wraps[0].metadata,epoch:2}}]}])
    await assert.rejects(parseGroupWrapBundle(value,owner));
  for(const index of [-1,1,NaN])await assert.rejects(f.client.publish(bundle,index));
  f.setView({...f.view,manifest:{...f.manifest,revisionId:'b'.repeat(64)}});
  await assert.rejects(f.client.publish(bundle,0));assert.equal(f.writes.length,0);
  await assert.rejects(f.client.prepare(scope,new Uint8Array(31)));
  await assert.rejects(f.client.prepare(scope,new Uint8Array(32)));
  assert.throws(()=>createGroupWrapClient('bad'));
  await assert.rejects(createGroupWrapClient(owner,async()=>new Response(null,{status:503}),()=>100).prepare(scope,secret));
  const aborted=new AbortController();aborted.abort();await assert.rejects(f.client.prepare(scope,secret,aborted.signal));
});
