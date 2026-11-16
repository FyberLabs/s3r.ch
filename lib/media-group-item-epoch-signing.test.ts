// Signing and HTTP contracts run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {prepareGroupItemEpoch} from "./media-group-item-epoch-signing";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const grant={object,owner,accessor:owner,from:0,until:10_000_000,stated:1,epoch:2,grantRevision:2,itemCiphertextDigest:"a".repeat(64)};
const direct={accessor:owner,from:0,until:grant.until,stated:1,grantRevision:2,scope:"direct",setId:"",hamState:0};
const group={...direct,accessor:reader,scope:scope.predicate,setId:scope.set,hamState:2};
const plan={at:100,fence:"b".repeat(64),owner,ownerPub:owner,...scope,previousEpoch:1,previousFinalizationId:"c".repeat(64),
  settleWindowMs:3600000,keyCommitment:"d".repeat(64),grants:[grant],bindings:{[owner]:{pub:owner,epub:owner,head:0}},groupReaders:[reader],
  snapshot:{entries:[direct,group],objectSet:{predicate:scope.predicate,setId:scope.set,stated:1,hamState:1}}};

const scalar=(n=1)=>{const k=new Uint8Array(32);k[31]=n;return k;};
const prepare=(fetcher:typeof fetch,clock=()=>100,key=scalar(),signal=new AbortController().signal)=>
  prepareGroupItemEpoch(object,scope,owner,"s3rch-group-share",key,fetcher,clock,signal);
test("signs one complete command under the original protected fence without publishing",async()=>{
  const key=scalar();let calls=0;
  const command=await prepare(async(url,init)=>{
    calls++;assert.equal(url,"/api/media/groups/item-epoch-view");
    assert.deepEqual(JSON.parse(String(init?.body)),{object,...scope});key.fill(0);return Response.json(plan);
  },()=>100,key);
  assert.equal(calls,1);assert.deepEqual(key,new Uint8Array(32));
  assert.equal(command.ownerPub,owner);assert.equal(command.body.at,100);assert.equal(command.body.fence,plan.fence);
  const {grants,document,finalization}=command.body.payload;
  assert.deepEqual(grants.map(g=>g.claims),plan.grants);assert.deepEqual(document.snapshot,plan.snapshot);
  for(const g of grants)assert.ok(verifyForumKeySignature(owner,g.proof.signature,Uint8Array.from(Buffer.from(g.proof.grantBytes,"hex"))));
  assert.equal(document.manifest.epoch,2);assert.equal(document.manifest.previousEpoch,1);
  assert.equal(document.manifest.keyCommitment,plan.keyCommitment);assert.equal(document.manifest.settleWindowMs,plan.settleWindowMs);
  assert.equal(finalization.revisionId,document.manifest.revisionId);assert.equal(finalization.previousFinalizationId,plan.previousFinalizationId);
  assert.deepEqual(finalization.candidateRevisionIds,[document.manifest.revisionId]);
  assert.deepEqual(Object.keys(command),["ownerPub","body"]);
  assert.deepEqual(Object.keys(command.body),["object","predicate","set","at","fence","payload"]);
});
test("detached metadata repair signs no live group recipients",async()=>{
  const detached={...plan,groupReaders:[],snapshot:{entries:[direct,{...group,stated:0}],objectSet:{...plan.snapshot.objectSet,stated:0,hamState:2}}};
  const command=await prepare(async()=>Response.json(detached));
  assert.equal(command.body.payload.document.snapshot.objectSet?.stated,0);
  assert.equal(command.body.payload.document.snapshot.entries.find(e=>e.accessor===reader)?.stated,0);
});
test("stale or incomplete preparation and wrong current signer refuse without retry",async()=>{
  for(const value of [{...plan,at:95},{...plan,groupReaders:[]},{...plan,ownerPub:reader}]){
    let calls=0;await assert.rejects(prepare(async()=>{calls++;return Response.json(value);}));assert.equal(calls,1);
  }
  await assert.rejects(prepare(async()=>Response.json(plan),()=>100,scalar(2)));
  let ticks=0,calls=0;
  await assert.rejects(prepare(async()=>{calls++;return Response.json(plan);},()=>++ticks>2?105:100));
  assert.equal(calls,1);
});
test("invalid inputs and cancellation never produce a saved command",async()=>{
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;return Response.json(plan);};
  await assert.rejects(prepare(fetcher,()=>100,new Uint8Array(1)));assert.equal(calls,0);
  await assert.rejects(prepareGroupItemEpoch(object,scope,owner,"bad id",scalar(),fetcher,()=>100,new AbortController().signal));assert.equal(calls,0);
  const before=new AbortController();before.abort();await assert.rejects(prepare(fetcher,()=>100,scalar(),before.signal));assert.equal(calls,0);
  const during=new AbortController();await assert.rejects(prepare(async()=>{during.abort();return Response.json(plan);},()=>100,scalar(),during.signal));
  await assert.rejects(prepare(async()=>new Response(null,{status:503})));
});
