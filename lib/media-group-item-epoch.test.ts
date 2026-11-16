// Pure metadata units: no HTTP, signing, native verifier or browser.
import test from "node:test";
import assert from "node:assert/strict";
import {parseGroupItemEpochPlan} from "./media-group-item-epoch";
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
const parse=(v:unknown)=>parseGroupItemEpochPlan(v,object,owner,scope,100);
test("complete plan is copied and binds direct and group recipients independently",()=>{
  const accepted=parse(plan);assert.deepEqual(accepted,plan);assert.notEqual(accepted,plan);
  assert.notEqual(accepted.snapshot,plan.snapshot);
  const detached={...plan,groupReaders:[],snapshot:{entries:[direct,{...group,stated:0}],objectSet:{...plan.snapshot.objectSet,stated:0,hamState:2}}};
  assert.deepEqual(parse(detached),detached);
  const rotated={...plan,ownerPub:reader,bindings:{[owner]:{pub:reader,epub:reader,head:4}}};
  assert.deepEqual(parse(rotated),rotated);
});
test("rejects foreign, stale and malformed preparations before signing",()=>{
  for(const patch of [{extra:1},{at:95},{at:102},{at:true},{owner:reader},{ownerPub:"bad"},{fence:"bad"},
      {predicate:"named-circle"},{set:"bad"},{previousEpoch:0},{previousEpoch:Number.MAX_SAFE_INTEGER},
      {previousFinalizationId:"bad"},{settleWindowMs:1},{keyCommitment:"bad"},{grants:[]},{bindings:[]},{groupReaders:null},{snapshot:{}}])
    assert.throws(()=>parse({...plan,...patch}));
  assert.throws(()=>parseGroupItemEpochPlan(plan,object,reader,scope,100));
  assert.throws(()=>parseGroupItemEpochPlan(plan,object,owner,scope,NaN));
});
test("rejects omitted, duplicate, mismatched and expired direct authority",()=>{
  for(const patch of [{epoch:1},{accessor:reader},{until:3700000},{from:100001},{stated:0},{itemCiphertextDigest:"bad"}])
    assert.throws(()=>parse({...plan,grants:[{...grant,...patch}]}));
  assert.throws(()=>parse({...plan,grants:[grant,grant]}));
  for(const bindings of [{},{[owner]:{pub:reader,epub:owner,head:0}},{[owner]:{pub:owner,epub:"bad",head:0}},
      {...plan.bindings,[reader]:plan.bindings[owner]}])assert.throws(()=>parse({...plan,bindings}));
  for(const entries of [[group],[direct,direct],[{...direct,grantRevision:3},group],[{...direct,hamState:1},group],
      [{...direct,scope:scope.predicate,setId:scope.set},group]])assert.throws(()=>parse({...plan,snapshot:{...plan.snapshot,entries}}));
});
test("group recipients cannot override direct authority or survive a detached edge",()=>{
  for(const groupReaders of [[],[reader,reader],[owner],["bad"]])assert.throws(()=>parse({...plan,groupReaders}));
  for(const patch of [{stated:0},{setId:"bad"},{from:100001},{until:3700000},{hamState:true}])
    assert.throws(()=>parse({...plan,snapshot:{...plan.snapshot,entries:[direct,{...group,...patch}]}}));
  for(const patch of [{stated:0},{predicate:"named-circle"},{hamState:true}])
    assert.throws(()=>parse({...plan,snapshot:{...plan.snapshot,objectSet:{...plan.snapshot.objectSet,...patch}}}));
  assert.throws(()=>parse({...plan,snapshot:{...plan.snapshot,entries:[direct]}}));
});

test("independent group authority survives expiry of an unrelated direct grant",()=>{
  const expired={...grant,accessor:reader,stated:0,until:90000,grantRevision:3};
  const refresh={...plan,grants:[grant,expired]};
  assert.deepEqual(parse(refresh),refresh);
  const retained={...plan,groupReaders:[],snapshot:{...plan.snapshot,entries:[direct,{...group,scope:"direct",setId:"",hamState:0,stated:0}]}};
  assert.deepEqual(parse(retained),retained);
  assert.throws(()=>parse({...refresh,grants:[grant,{...expired,itemCiphertextDigest:"e".repeat(64)}]}));
});

test("epoch preparation transport shapes require the owner and bounded metadata",async()=>{
  const {parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit}=await import("./media-group-command");
  const body={object,...scope};
  assert.deepEqual(parseGroupCommand("item-epoch-view",body,owner),body);
  assert.deepEqual(parseGroupCommandResult("item-epoch-view",plan,body,100,owner),plan);
  assert.equal(groupRequestLimit("item-epoch-view"),2048);assert.equal(groupResponseLimit("item-epoch-view"),262144);
  for(const patch of [{owner},{object:scope.set},{set:"bad"}])assert.throws(()=>parseGroupCommand("item-epoch-view",{...body,...patch},owner));
  assert.throws(()=>parseGroupCommand("item-epoch-view",body,reader));
  assert.throws(()=>parseGroupCommandResult("item-epoch-view",plan,body,100));
  assert.throws(()=>parseGroupCommandResult("item-epoch-view",plan,body,105,owner));
});
