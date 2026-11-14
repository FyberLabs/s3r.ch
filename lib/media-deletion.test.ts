import test from "node:test";
import assert from "node:assert/strict";
import { signPrivateMediaDeletion } from "sociacl-ids/private-media";
import { parseMediaDeletionDraft, parseMediaDeletionIntent } from "./media-deletion";
const tenant="11111111-1111-4111-8111-111111111111";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const claims={tenant,object,owner,objectVersion:1,fence:"a".repeat(64),issuedAt:100000,expiresAt:160000};
const draft={at:100,ownerPub:owner,claims};
function intent(){const key=new Uint8Array(32);key[31]=1;return {tenant,object,owner,ownerPub:owner,at:100,proof:signPrivateMediaDeletion(claims,key,owner).proof};}
test("deletion intent is a copied immutable public transcript bound to its draft",()=>{
  assert.deepEqual(parseMediaDeletionDraft(draft,tenant,object,owner),draft);
  const input=intent(),parsed=parseMediaDeletionIntent(input);
  assert.deepEqual(parsed,input);assert.notEqual(parsed,input);assert.notEqual(parsed.proof,input.proof);
  assert.ok(Object.isFrozen(parsed)&&Object.isFrozen(parsed.proof));
});
test("draft rejects wrong tenant, object, owner, time, version and bounds",()=>{
  for(const value of [null,[],{...draft,extra:1},{...draft,at:true},{...draft,ownerPub:"bad"},
    ...[{tenant:"other"},{object:"bad"},{owner:"other"},{objectVersion:-1},{fence:"bad"},{issuedAt:100001},{expiresAt:100000},{expiresAt:160001}].map(c=>({...draft,claims:{...claims,...c}}))]){
    assert.throws(()=>parseMediaDeletionDraft(value,tenant,object,owner));
  }
  for(const [t,o,p] of [["bad",object,owner],["00000000-0000-0000-0000-000000000000",object,owner],[tenant,"bad",owner],[tenant,object,"bad"]])assert.throws(()=>parseMediaDeletionDraft(draft,t,o,p));
});
test("intent rejects malformed proofs, rewritten scope and noncanonical transcripts",()=>{
  const input=intent();
  for(const value of [null,{...input,extra:1},{...input,at:101},{...input,tenant:"22222222-2222-4222-8222-222222222222"},
    {...input,proof:[]},{...input,proof:{...input.proof,signature:"bad"}},
    ...["", "zz", "aa".repeat(2049),Buffer.from("bad domain").toString("hex"),Buffer.from("SOCIACL_PRIVATE_MEDIA_DELETE_V1\n[]").toString("hex"),Buffer.from("SOCIACL_PRIVATE_MEDIA_DELETE_V1\n "+JSON.stringify(Object.values(claims))).toString("hex")].map(deletionBytes=>({...input,proof:{...input.proof,deletionBytes}}))])assert.throws(()=>parseMediaDeletionIntent(value));
});
