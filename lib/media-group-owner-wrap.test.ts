// Pure response-shape unit tests only.
import test from "node:test";
import assert from "node:assert/strict";
import {parseOwnerWrapResult} from "./media-group-owner-wrap";
import {owner,reader,object,scope} from "./media-group-item-epoch-fixture";
import {parseGroupCommand,groupRequestLimit,groupResponseLimit} from "./media-group-command";
const body={object,...scope},value={object,predicate:scope.predicate,set_id:scope.set,epoch:1,revision_id:'a'.repeat(64),reader_epub:owner,key_commitment:'b'.repeat(64),item_digest:'c'.repeat(64),expires_at:102,payload:'YWJj'};
test("owner maintenance metadata is bounded and scoped independently of opaque bytes",()=>{
  assert.deepEqual(parseOwnerWrapResult(value,body,100),value);
  assert.deepEqual(parseGroupCommand('item-owner-wrap-read',body,owner),body);
  assert.throws(()=>parseGroupCommand('item-owner-wrap-read',body,reader));
  assert.equal(groupRequestLimit('item-owner-wrap-read'),2048);assert.equal(groupResponseLimit('item-owner-wrap-read'),92160);
  for(const patch of [{object:'other'},{predicate:'direct'},{set_id:'other'},{epoch:0},{epoch:true},{revision_id:'bad'},{key_commitment:'bad'},
      {reader_epub:''},{reader_epub:'x'.repeat(1025)},{expires_at:100},{expires_at:103},{expires_at:true},{payload:''},{payload:'!'},{payload:'a'.repeat(87388)},{extra:1}])
    assert.throws(()=>parseOwnerWrapResult({...value,...patch},body,100));
  assert.throws(()=>parseOwnerWrapResult(value,body,NaN));assert.throws(()=>parseOwnerWrapResult(null,body,100));
});
