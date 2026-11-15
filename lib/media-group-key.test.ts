// Shape-only units; real signatures, HTTP and browser contracts run in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {parseGroupKeyCommand,parseGroupKeySnapshot,parseGroupKeyView} from "./media-group-key";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit} from "./media-group-command";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const set="set_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set};
const member={accessor:owner,stated:1,hamState:1,signingPub:owner,encryptionPub:other,identityHead:0};
const snapshot={predicate:scope.predicate,setId:set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:other,ownerIdentityHead:0,members:[member]};
const config={owner,setId:set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:"1".repeat(128)};
const manifest={object:set,previousEpoch:0,epoch:1,deviceId:"device",revisionId:"a".repeat(64),keyCommitment:"b".repeat(64),settleWindowMs:3600000,aclSnapshot:"c".repeat(64),signature:"1".repeat(128)};
const finalization={object:set,previousEpoch:0,epoch:1,revisionId:manifest.revisionId,candidateRevisionIds:[manifest.revisionId],previousFinalizationId:"",finalizationId:"d".repeat(64),signature:"1".repeat(128)};
const command={document:{manifest,snapshot},finalization};
const view={at:100,fence:"e".repeat(64),snapshot,config,previousEpoch:0,previousFinalizationId:""};

test("group key requests bind owner and preserve exact signed command",()=>{
  assert.deepEqual(parseGroupKeyCommand(command,scope),command);
  for(const action of ["key-view","key-state","key-append"] as const){
    const body={...scope,...(action!=="key-view"?{command}:{}),...(action==="key-append"?{at:100,fence:view.fence}:{})};
    assert.deepEqual(parseGroupCommand(action,body,owner),body);
    assert.throws(()=>parseGroupCommand(action,body,other));
    assert.throws(()=>parseGroupCommand(action,{...body,writer:owner},owner));
  }
  assert.deepEqual(parseGroupCommandResult("key-view",view,scope,100,owner),view);
  assert.deepEqual(parseGroupCommandResult("key-append",{accepted:true},scope,100,owner),{accepted:true});
  assert.deepEqual(parseGroupCommandResult("key-state",{at:100,state:"applied",fence:view.fence},scope,100,owner),{at:100,state:"applied",fence:view.fence});
  assert.throws(()=>parseGroupCommandResult("key-view",{...view,at:90},scope,100,owner));
  assert.equal(groupRequestLimit("key-append"),73728);assert.equal(groupRequestLimit("key-state"),73728);
  assert.equal(groupRequestLimit("key-view"),18432);assert.equal(groupResponseLimit("key-view"),73728);assert.equal(groupResponseLimit("key-state"),18432);
});
test("snapshots reject unknown fields, duplicate members, bad current bindings and unsafe heads",()=>{
  assert.deepEqual(parseGroupKeySnapshot({...snapshot,members:[]},scope).members,[]);
  for(const patch of [{extra:1},{predicate:"named-circle"},{setId:"bad"},{setOwner:other},{ownerSigningPub:"bad"},{ownerEncryptionPub:"bad"},{ownerIdentityHead:-1},{members:Array(65).fill(member)},{members:[member,member]}])
    assert.throws(()=>parseGroupKeySnapshot({...snapshot,...patch},scope));
  for(const patch of [{extra:1},{accessor:"bad"},{stated:true},{hamState:-1},{signingPub:"bad"},{encryptionPub:"bad"},{identityHead:2**54},{signingPub:other},{encryptionPub:owner},{identityHead:1}])
    assert.throws(()=>parseGroupKeySnapshot({...snapshot,members:[{...member,...patch}]},scope));
  assert.doesNotThrow(()=>parseGroupKeySnapshot({...snapshot,members:[{...member,accessor:other}]},scope));
});
test("commands require one exact successor and bounded native shapes",()=>{
  for(const input of [null,[],{}, {...command,extra:1},{document:{manifest},finalization},{...command,padding:"x".repeat(65537)}])
    assert.throws(()=>parseGroupKeyCommand(input,scope));
  for(const patch of [{object:"bad"},{previousEpoch:1},{epoch:2},{epoch:true},{deviceId:""},{deviceId:"x".repeat(129)},{revisionId:"bad"},{keyCommitment:"bad"},{aclSnapshot:"bad"},{signature:"bad"},{settleWindowMs:1},{settleWindowMs:259200001},{extra:1}])
    assert.throws(()=>parseGroupKeyCommand({...command,document:{snapshot,manifest:{...manifest,...patch}}},scope));
  for(const patch of [{object:"bad"},{previousEpoch:1},{epoch:2},{revisionId:"b".repeat(64)},{candidateRevisionIds:[]},{candidateRevisionIds:[manifest.revisionId,manifest.revisionId]},{previousFinalizationId:"a".repeat(64)},{finalizationId:"bad"},{signature:"bad"},{extra:1}])
    assert.throws(()=>parseGroupKeyCommand({...command,finalization:{...finalization,...patch}},scope));
  const later={document:{snapshot,manifest:{...manifest,previousEpoch:1,epoch:2}},finalization:{...finalization,previousEpoch:1,epoch:2,previousFinalizationId:"a".repeat(64)}};
  assert.doesNotThrow(()=>parseGroupKeyCommand(later,scope));
  assert.throws(()=>parseGroupKeyCommand({...later,finalization:{...later.finalization,previousFinalizationId:""}},scope));
});
test("preparation requires exact policy, safe parent and a scope-bound snapshot",()=>{
  assert.deepEqual(parseGroupKeyView(view,scope),view);
  for(const patch of [{extra:1},{at:true},{fence:"bad"},{previousEpoch:Number.MAX_SAFE_INTEGER},{previousFinalizationId:"a".repeat(64)},{snapshot:{}},{config:{}}])
    assert.throws(()=>parseGroupKeyView({...view,...patch},scope));
  assert.doesNotThrow(()=>parseGroupKeyView({...view,previousEpoch:1,previousFinalizationId:"a".repeat(64)},scope));
  assert.throws(()=>parseGroupKeyView({...view,previousEpoch:1},scope));
});
