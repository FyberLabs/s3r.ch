// Pure shape units; HTTP, key wrapping and browser execution belong to CI.
import test from "node:test";
import assert from "node:assert/strict";
import {owner,reader,object,scope} from "./media-group-item-epoch-fixture";
import {parseGroupCommand as command,parseGroupCommandResult as result,groupRequestLimit,groupResponseLimit} from "./media-group-command";
const target={object,...scope},draft={...target,reader};
const metadata={itemEpoch:2,itemRevisionId:"a".repeat(64),itemDigest:"b".repeat(64),groupEpoch:3,groupRevisionId:"c".repeat(64),groupKeyCommitment:"d".repeat(64)};
const view={at:100,fence:"e".repeat(64),ownerPub:owner,metadata};
const body={...draft,at:100,fence:view.fence,metadata:{...metadata,digest:"f".repeat(64)},payload:btoa("opaque")};
const read={...target,predicate:scope.predicate,set_id:scope.set,payload:body.payload,item_epoch:2,item_revision_id:metadata.itemRevisionId,
  item_digest:metadata.itemDigest,group_epoch:3,group_revision_id:metadata.groupRevisionId,group_key_commitment:metadata.groupKeyCommitment,expires_at:102};
delete (read as Partial<typeof read>).set;
test("item wrap contracts preserve both epochs and fixed authenticated parties",()=>{
  assert.deepEqual(command("item-wrap-view",draft,owner),draft);
  assert.deepEqual(command("item-wrap-publish",body,owner),body);
  assert.deepEqual(command("item-wrap-read",target,reader),target);
  assert.deepEqual(result("item-wrap-view",view,draft,100),view);
  assert.deepEqual(result("item-wrap-read",read,target,100),read);
  assert.deepEqual(result("item-wrap-publish",{digest:body.metadata.digest},body,100),{digest:body.metadata.digest});
  for(const action of ["item-wrap-view","item-wrap-read"] as const)assert.equal(groupRequestLimit(action),2048);
  assert.equal(groupRequestLimit("item-wrap-publish"),92160);assert.equal(groupResponseLimit("item-wrap-read"),92160);
});
test("owner-only publication rejects malformed scope, metadata and opaque bytes",()=>{
  assert.throws(()=>command("item-wrap-view",draft,reader));assert.throws(()=>command("item-wrap-read",target,"bad"));
  for(const patch of [{object:scope.set},{object:"media_bad"},{reader:"bad"},{set:"bad"},{extra:true},{at:true},{fence:"bad"}])
    assert.throws(()=>command("item-wrap-publish",{...body,...patch},owner));
  for(const patch of [{itemEpoch:0},{itemEpoch:true},{groupEpoch:0},{itemRevisionId:"bad"},{itemDigest:"bad"},{groupRevisionId:"bad"},{groupKeyCommitment:"bad"},{digest:"bad"},{extra:1}])
    assert.throws(()=>command("item-wrap-publish",{...body,metadata:{...body.metadata,...patch}},owner));
  for(const payload of [null,"","!","YR==",btoa("x".repeat(65537))])assert.throws(()=>command("item-wrap-publish",{...body,payload},owner));
  assert.throws(()=>command("item-wrap-read",{...target,reader},reader));
  assert.throws(()=>command("item-wrap-view",null,owner));
});
test("responses refuse foreign scope, stale authorization and unexpected fields",()=>{
  for(const patch of [{at:95},{at:103},{at:true},{ownerPub:"bad"},{fence:"bad"},{metadata:null},{extra:1}])
    assert.throws(()=>result("item-wrap-view",{...view,...patch},draft,100));
  assert.throws(()=>result("item-wrap-view",view,draft,NaN));
  for(const patch of [{object:scope.set},{predicate:"named-circle"},{set_id:"bad"},{expires_at:100},{expires_at:103},{expires_at:true},
    {item_epoch:0},{group_epoch:0},{item_digest:"bad"},{payload:"!"},{extra:1}])assert.throws(()=>result("item-wrap-read",{...read,...patch},target,100));
  assert.throws(()=>result("item-wrap-read",read,target,NaN));
  for(const v of [null,{digest:"x"},{digest:"a".repeat(64)},{digest:body.metadata.digest,extra:1}])assert.throws(()=>result("item-wrap-publish",v,body,100));
});
