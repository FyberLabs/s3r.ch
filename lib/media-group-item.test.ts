// Pure shape units: no HTTP, browser, signing or native authority execution.
import test from "node:test";
import assert from "node:assert/strict";
import {parseGroupCommand,parseGroupCommandResult} from "./media-group-command";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const body={object,predicate:"same-group",set:object.replace("media_","set_")};
const result={...body,at:100,expiresAt:102,fence:"a".repeat(64),ownerPub:owner,
  item:{epoch:1,revisionId:"b".repeat(64),digest:"c".repeat(64)},
  group:{epoch:1,revisionId:"d".repeat(64),keyCommitment:"e".repeat(64)}};
const parse=(v:unknown)=>parseGroupCommandResult("item-view",v,body,100);
test("item preparation fixes the owned object and snapshots accepted context",()=>{
  assert.deepEqual(parseGroupCommand("item-view",body,owner),body);
  const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
  const point=other.split(".").map(part=>Buffer.from(part,"base64url").toString("hex")).join("");
  const foreignGroup={...body,set:"set_p_"+point+"_"+"2".repeat(32)};
  assert.deepEqual(parseGroupCommand("item-view",foreignGroup,owner),foreignGroup);
  assert.throws(()=>parseGroupCommand("item-view",body,other));
  const rotated={...result,...foreignGroup,ownerPub:other};
  assert.deepEqual(parseGroupCommandResult("item-view",rotated,foreignGroup,100),rotated);
  const parsed=parse(result);assert.deepEqual(parsed,result);assert.notEqual(parsed,result);
  for(const object of [null,"bad",body.set])assert.throws(()=>parseGroupCommand("item-view",{...body,object},owner));
  assert.throws(()=>parseGroupCommand("item-view",{...body,owner},owner));
  assert.throws(()=>parseGroupCommand("item-view",body,"bad"));
});
test("item preparation rejects expired, mismatched or malformed context",()=>{
  for(const patch of [{extra:true},{object:"other"},{predicate:"named-circle"},{set:"other"},{fence:"bad"},
      {ownerPub:null},{ownerPub:"bad"},{expiresAt:100},{expiresAt:103},{expiresAt:true},{at:95},{at:102},
      {at:99,expiresAt:102},{item:{}},{group:{}}])assert.throws(()=>parse({...result,...patch}));
  for(const field of ["item","group"] as const){
    for(const patch of [{epoch:0},{epoch:true},{revisionId:"bad"},field==="item"?{digest:"bad"}:{keyCommitment:"bad"}])
      assert.throws(()=>parse({...result,[field]:{...result[field],...patch}}));
  }
});
