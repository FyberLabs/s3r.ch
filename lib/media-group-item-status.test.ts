// Pure shape units; no signing, HTTP or browser execution.
import test from "node:test";
import assert from "node:assert/strict";
import {owner,reader,object,scope} from "./media-group-item-epoch-fixture";
import {parseItemStatusCommand,parseItemStatusResult} from "./media-group-item-status";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit} from "./media-group-command";
const draft={object,...scope,reader},status={object,epoch:2,revisionId:"a".repeat(64),accessor:reader,grantRevision:1,stated:1,
  signedAt:100000,maxAgeMs:60000,zookie:{object,objectVersion:3,snapshotHash:"b".repeat(64)}};
const view={at:100,fence:"c".repeat(64),ownerPub:owner,status},payload={...status,signature:"d".repeat(128)},body={...draft,at:100,fence:view.fence,payload};
test("status plans and signed commands bind owner, object and recipient",()=>{
  assert.deepEqual(parseGroupCommand("item-status-view",draft,owner),draft);
  assert.deepEqual(parseGroupCommandResult("item-status-view",view,draft,100,owner),view);
  assert.deepEqual(parseGroupCommand("item-status-append",body,owner),body);
  assert.deepEqual(parseGroupCommand("item-status-state",{...draft,payload},owner),{...draft,payload});
  assert.deepEqual(parseGroupCommandResult("item-status-append",{accepted:true},body,100),{accepted:true});
  assert.deepEqual(parseGroupCommandResult("item-status-state",{at:100,state:"applied"},draft,100),{at:100,state:"applied"});
  assert.equal(groupRequestLimit("item-status-view"),2048);assert.equal(groupRequestLimit("item-status-append"),8192);
  assert.equal(groupRequestLimit("item-status-state"),8192);
});
test("malformed and foreign status fields are refused",()=>{
  const parse=(v:unknown)=>parseItemStatusCommand("item-status-append",v,owner);
  for(const patch of [{object:scope.set},{reader:"bad"},{reader:owner},{extra:1},{at:99},{at:true},{fence:"bad"}])assert.throws(()=>parse({...body,...patch}));
  assert.throws(()=>parseItemStatusCommand("item-status-view",draft,reader));
  for(const patch of [{object:scope.set},{epoch:0},{revisionId:"bad"},{grantRevision:0},{stated:0},{signedAt:-1},{maxAgeMs:0},{maxAgeMs:60001},
      {zookie:{...status.zookie,object:scope.set}},{zookie:{...status.zookie,objectVersion:true}},{zookie:{...status.zookie,snapshotHash:"bad"}},{signature:"bad"},{extra:1}])
    assert.throws(()=>parse({...body,payload:{...payload,...patch}}));
});
test("preparation requires current bounded status and state is only exact acceptance",()=>{
  for(const patch of [{at:95},{at:103},{fence:"bad"},{ownerPub:"bad"},{status:{...status,signedAt:99000}},{status:{...status,maxAgeMs:1}},{extra:1}])
    assert.throws(()=>parseItemStatusResult("item-status-view",{...view,...patch},draft,101));
  assert.throws(()=>parseItemStatusResult("item-status-view",view,draft,NaN));
  for(const value of [null,{accepted:false},{accepted:true,extra:1}])assert.throws(()=>parseItemStatusResult("item-status-append",value,body,100));
  for(const value of [null,{at:100,state:"settled"},{at:95,state:"applied"},{at:100,state:"applied",frozen:false}])
    assert.throws(()=>parseItemStatusResult("item-status-state",value,draft,100));
});
