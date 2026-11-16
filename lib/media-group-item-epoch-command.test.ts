// Pure shape units only: no signing, HTTP, browser or native calls.
import test from "node:test";
import assert from "node:assert/strict";
import {owner,reader,scope,savedEpoch} from "./media-group-item-epoch-fixture";
import {parseItemEpochCommand,parseSignedItemEpoch,parseItemEpochResult} from "./media-group-item-epoch-command";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit} from "./media-group-command";
test("retained command preserves the original complete plan and is copied",()=>{
  const saved=savedEpoch(),parsed=parseSignedItemEpoch(saved,owner);
  assert.deepEqual(parsed,saved);assert.notEqual(parsed.body,saved.body);
  const {object,predicate,set,payload}=saved.body;
  const state={object,predicate,set,payload};
  assert.deepEqual(parseGroupCommand("item-epoch-append",saved.body,owner),saved.body);
  assert.deepEqual(parseGroupCommand("item-epoch-state",state,owner),state);
  assert.equal(groupRequestLimit("item-epoch-append"),270336);
  assert.equal(groupRequestLimit("item-epoch-state"),270336);
  assert.deepEqual(parseGroupCommandResult("item-epoch-append",{accepted:true},saved.body,100),{accepted:true});
  assert.deepEqual(parseGroupCommandResult("item-epoch-state",{at:100,state:"absent"},state,100),{at:100,state:"absent"});
});
test("rejects substituted identities, plans, fences and claims",()=>{
  const mutate:( (v:ReturnType<typeof savedEpoch>)=>void)[]=[
    v=>{v.ownerPub=reader;},v=>{v.plan.fence="a".repeat(64);},v=>{v.plan.at=99;},
    v=>{v.body.payload.document.manifest.keyCommitment="a".repeat(64);},
    v=>{v.body.payload.finalization.previousFinalizationId="e".repeat(64);},
    v=>{v.body.payload.grants[0].claims.grantRevision=3;},
    v=>{v.body.payload.document.snapshot.entries[1].hamState=3;},
  ];
  for(const change of mutate){const v=savedEpoch();change(v);assert.throws(()=>parseSignedItemEpoch(v,owner));}
  for(const value of [null,[],{}, {...savedEpoch(),extra:1},{...savedEpoch(),ownerPub:"bad"}])assert.throws(()=>parseSignedItemEpoch(value,owner));
  assert.throws(()=>parseSignedItemEpoch(savedEpoch(),reader));
});
test("strict epoch shapes reject incomplete or foreign atomic payloads",()=>{
  const base=savedEpoch().body;
  const parse=(v:unknown)=>parseItemEpochCommand("item-epoch-append",v,owner);
  for(const patch of [{extra:1},{object:scope.set},{at:true},{fence:"bad"},{payload:null}])assert.throws(()=>parse({...base,...patch}));
  for(const patch of [{grants:[]},{grants:Array(65).fill(base.payload.grants[0])},{document:{}},{extra:1}])
    assert.throws(()=>parse({...base,payload:{...base.payload,...patch}}));
  for(const patch of [{object:scope.set},{previousEpoch:0},{epoch:4},{deviceId:"bad id"},{signature:"bad"},{settleWindowMs:1},{aclSnapshot:"bad"}])
    assert.throws(()=>parse({...base,payload:{...base.payload,document:{...base.payload.document,manifest:{...base.payload.document.manifest,...patch}}}}));
  for(const patch of [{revisionId:"a".repeat(64)},{candidateRevisionIds:[]},{signature:"bad"}])
    assert.throws(()=>parse({...base,payload:{...base.payload,finalization:{...base.payload.finalization,...patch}}}));
  for(const patch of [{entries:[]},{entries:[base.payload.document.snapshot.entries[0],base.payload.document.snapshot.entries[0]]},
      {objectSet:{...base.payload.document.snapshot.objectSet,stated:0}}])
    assert.throws(()=>parse({...base,payload:{...base.payload,document:{...base.payload.document,snapshot:{...base.payload.document.snapshot,...patch}}}}));
  const duplicate=savedEpoch();duplicate.body.payload.grants.push(duplicate.body.payload.grants[0]);assert.throws(()=>parse(duplicate.body));
  const huge=savedEpoch();huge.body.payload.grants[0].proof.grantBytes="aa".repeat(150000);assert.throws(()=>parse(huge.body));
});
test("acknowledgments and exact-state answers must be bounded and current",()=>{
  assert.deepEqual(parseItemEpochResult("item-epoch-state",{at:100,state:"applied"},100),{at:100,state:"applied"});
  for(const value of [null,{accepted:false},{accepted:true,extra:1}])assert.throws(()=>parseItemEpochResult("item-epoch-append",value,100));
  for(const value of [null,{at:95,state:"applied"},{at:102,state:"applied"},{at:100,state:"settled"},{at:100,state:"absent",frozen:false}])
    assert.throws(()=>parseItemEpochResult("item-epoch-state",value,100));
  assert.throws(()=>parseItemEpochResult("item-epoch-state",{at:100,state:"applied"},NaN));
});
