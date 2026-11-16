// Pure parser units; no signing, transport or storage.
import test from "node:test";
import assert from "node:assert/strict";
import {parseItemGrantCommand as command,parseItemGrantResult as result,parseItemGrantClaims} from "./media-group-item-grant";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")},fence="a".repeat(64);
const draft={object,...scope,reader,withdraw:false};
const claims={object,owner,accessor:reader,from:100000,until:7400000,stated:1 as const,epoch:2,grantRevision:1,itemCiphertextDigest:fence};

const payload={claims,proof:{grantBytes:"ab",signature:"a".repeat(128)}};
const append={object,...scope,at:100,fence,payload};
const view={at:100,fence,ownerPub:owner,grant:claims};
test("grant parsing detaches exact owner and recipient context",()=>{
  assert.deepEqual(command("item-grant-view",draft,owner),draft);
  const held=command("item-grant-append",append,owner);assert.deepEqual(held,append);assert.notEqual(held.payload,payload);
  assert.deepEqual(command("item-grant-state",{object,...scope,payload},owner),{object,...scope,payload});
  assert.deepEqual(result("item-grant-view",view,draft,100,owner),view);
  assert.deepEqual(result("item-grant-append",{accepted:true},append,100,owner),{accepted:true});
  for(const state of ["applied","absent"])assert.deepEqual(result("item-grant-state",{at:100,state,frozen:true},append,100,owner),{at:100,state,frozen:true});
  const cancelled={...claims,stated:0,from:0,until:1};
  assert.ok(result("item-grant-view",{...view,grant:cancelled},{...draft,withdraw:true},100,owner));
});
test("claims refuse ambiguous fields, scope changes and unsafe numeric values",()=>{
  for(const bad of [null,{},[],{...claims,extra:1},{...claims,object:scope.set},{...claims,owner:reader},{...claims,accessor:"bad"},
    ...["from","until","epoch","grantRevision"].flatMap(k=>[false,-1,1.5,Number.MAX_SAFE_INTEGER+1].map(v=>({...claims,[k]:v}))),
    {...claims,until:claims.from},{...claims,stated:2},{...claims,epoch:0},{...claims,grantRevision:0},{...claims,itemCiphertextDigest:"A".repeat(64)}])
    assert.throws(()=>parseItemGrantClaims(bad,object,owner));
});
test("commands reject ownership, proof and transport shape mismatches",()=>{
  for(const bad of [null,{},[],{...draft,extra:1},{...draft,reader:"bad"},{...draft,withdraw:1},{...draft,object:scope.set},{...draft,predicate:"direct"}])
    assert.throws(()=>command("item-grant-view",bad,owner));
  assert.throws(()=>command("item-grant-view",draft,reader));assert.throws(()=>command("item-grant-view",draft,"bad"));
  for(const bad of [{...append,at:-1},{...append,fence:"bad"},{...append,payload:null},
    ...[{grantBytes:"a",signature:"a".repeat(128)},{grantBytes:"AB",signature:"a".repeat(128)},
      {grantBytes:"ab",signature:"a"},{grantBytes:"ab".repeat(2200),signature:"a".repeat(128)},null].map(proof=>({...append,payload:{claims,proof}}))])
    assert.throws(()=>command("item-grant-append",bad,owner));
});
test("responses reject stale and mismatched signing drafts",()=>{
  for(const bad of [null,{}, {...view,at:95},{...view,at:102},{...view,at:false},{...view,fence:"bad"},{...view,ownerPub:"bad"},
    {...view,grant:{...claims,accessor:owner}},{...view,grant:{...claims,stated:0}},{...view,grant:{...claims,from:99000}}])
    assert.throws(()=>result("item-grant-view",bad,draft,100,owner));
  assert.throws(()=>result("item-grant-view",view,draft,NaN,owner));
  for(const bad of [{accepted:false},{accepted:true,extra:1},null])assert.throws(()=>result("item-grant-append",bad,append,100,owner));
  for(const bad of [{at:100,state:"other",frozen:false},{at:100,state:"applied",frozen:0}])assert.throws(()=>result("item-grant-state",bad,append,100,owner));
});
