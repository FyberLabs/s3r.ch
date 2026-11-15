// Shape-only unit tests; transport and browser checks run in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit} from "./media-group-command";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const set="set_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set};
const member={accessor:owner,stated:1,hamState:1,signingPub:owner,encryptionPub:other,identityHead:0};
const snapshot={predicate:scope.predicate,setId:set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:other,ownerIdentityHead:0,members:[member]};
const config={owner,setId:set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:"1".repeat(128)};
const manifest={object:set,previousEpoch:0,epoch:1,deviceId:"device",revisionId:"a".repeat(64),keyCommitment:"b".repeat(64),settleWindowMs:3600000,aclSnapshot:"c".repeat(64),signature:"1".repeat(128)};

const metadata={reader:owner,readerEpub:other,epoch:1,revisionId:manifest.revisionId,digest:"d".repeat(64)};
const publication={...scope,at:100,fence:"e".repeat(64),metadata,payload:btoa("opaque")};
test("group wrap requests preserve fixed owner and bounded canonical ciphertext",()=>{
  assert.deepEqual(parseGroupCommand("wrap-publish",publication,owner),publication);
  assert.deepEqual(parseGroupCommand("wrap-read",scope,other),scope);
  assert.throws(()=>parseGroupCommand("wrap-view",scope,other));
  assert.throws(()=>parseGroupCommand("wrap-publish",publication,other));
  for(const payload of ["", "!", "YR==",btoa("x".repeat(65537))])
    assert.throws(()=>parseGroupCommand("wrap-publish",{...publication,payload},owner));
  for(const patch of [{reader:"bad"},{readerEpub:"bad"},{epoch:0},{epoch:true},{revisionId:"bad"},{digest:"bad"},{extra:1}])
    assert.throws(()=>parseGroupCommand("wrap-publish",{...publication,metadata:{...metadata,...patch}},owner));
  assert.throws(()=>parseGroupCommand("wrap-publish",{...publication,at:true},owner));
  assert.throws(()=>parseGroupCommand("wrap-read",{...scope,reader:owner},owner));
  assert.equal(groupRequestLimit("wrap-publish"),92160);assert.equal(groupResponseLimit("wrap-read"),92160);
});
test("group wrap view and delivery bind current scope and expiry",()=>{
  const view={at:100,fence:"e".repeat(64),snapshot,manifest};
  assert.deepEqual(parseGroupCommandResult("wrap-view",view,scope,100,owner),view);
  for(const patch of [{at:90},{fence:"bad"},{snapshot:{}},{manifest:{...manifest,object:"wrong"}},{extra:1}])
    assert.throws(()=>parseGroupCommandResult("wrap-view",{...view,...patch},scope,100,owner));
  assert.deepEqual(parseGroupCommandResult("wrap-publish",{digest:metadata.digest},publication,100,owner),{digest:metadata.digest});
  assert.throws(()=>parseGroupCommandResult("wrap-publish",{digest:"f".repeat(64)},publication,100,owner));
  const read={payload:publication.payload,predicate:scope.predicate,set_id:set,epoch:1,revision_id:manifest.revisionId,
    reader_epub:other,key_commitment:manifest.keyCommitment,expires_at:102};
  assert.deepEqual(parseGroupCommandResult("wrap-read",read,scope,100,other),read);
  for(const patch of [{set_id:"wrong"},{predicate:"named-circle"},{epoch:0},{revision_id:"bad"},{reader_epub:"bad"},
    {key_commitment:"bad"},{expires_at:100},{expires_at:103},{payload:"!"},{extra:1}])
    assert.throws(()=>parseGroupCommandResult("wrap-read",{...read,...patch},scope,100,other));
});
