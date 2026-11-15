// Packed shared producers and client boundary contracts run in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {snapshotOwnerGroupDraft,signOwnerGroupRow} from "./media-group-signing";
import {parseForumAuthority} from "./identity/forum-authority-records";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
import {createPrivateMediaOwner,PrivateMediaConflict} from "./media-owner-client";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const scalar=()=>{const key=new Uint8Array(32);key[31]=1;return key;};
const edge={owner,object,stated:1,hamState:1,cancels:[]};
const member={role:"set",member:other,setOwner:owner,stated:1,hamState:1,cancels:[]};
const view={at:100,fence:"a".repeat(64),owner,objectVersion:1,snapshot:{entries:[]},bindings:{[owner]:{pub:owner,epub:owner,head:0}}};
test("owner producers use shared canonical signatures and refuse another party's assent",()=>{
  for(const [kind,draft] of [["object-set",edge],["membership",member],["membership",{...member,role:"member",member:owner}]] as const){
    const signed=signOwnerGroupRow(kind,draft,scope,object,owner,100,scalar(),owner);
    const parsed=parseForumAuthority(kind,signed.record);assert.ok(parsed);
    assert.equal(parsed.soul,signed.soul);assert.equal(verifyForumKeySignature(owner,signed.record.sig,parsed.bytes),true);
    const cancel={kind:kind==="membership"?"membership":"object-set",rowSoul:signed.soul,cancelId:"a".repeat(64),prior:[],
      signer:owner,member:kind==="membership"?draft.member:owner,setOwner:owner,...(kind==="object-set"?{object}:{})};
    const cancelled=signOwnerGroupRow("cancel",cancel,scope,object,owner,100,scalar(),owner);
    assert.ok(parseForumAuthority("cancel",cancelled.record));
  }
  for(const [kind,draft] of [["membership",{...member,role:"member"}],["membership",{...member,role:"bad"}],
    ["object-set",{...edge,owner:other}],["object-set",{...edge,object:"bad"}],
    ["cancel",{signer:other}],["cancel",{signer:owner,kind:"object-set",object:"bad"}]] as const)
    assert.throws(()=>signOwnerGroupRow(kind,draft,scope,object,owner,100,scalar(),owner));
  assert.throws(()=>signOwnerGroupRow("object-set",edge,scope,object,owner,100,scalar(),other));
});
test("draft snapshots reject injected signatures and executable or unbounded lists",()=>{
  let read=false;const getter=Object.defineProperty({},"owner",{get(){read=true;return owner;}});
  const list=Object.defineProperty(["a"],"0",{get(){read=true;return "a";}});
  const iterator:string[]=[];Object.defineProperty(iterator,Symbol.iterator,{value:()=>{read=true;return [][Symbol.iterator]();}});
  for(const bad of [null,[],getter,{sig:"x"},{issuedAt:1},{predicate:"same-group"},{set:scope.set},{attest:"x"},
    {[Symbol("extra")]:1},{nested:{}},{cancels:list},{cancels:iterator},{cancels:new Array(1)},
    {cancels:Array(65).fill("a")},{cancels:[1]},{other:[]}])assert.throws(()=>snapshotOwnerGroupDraft(bad));
  assert.equal(read,false);
  const input={...edge,cancels:["a".repeat(64)]},held=snapshotOwnerGroupDraft(input);input.cancels.length=0;
  assert.equal((held.cancels as string[]).length,1);
});
test("client detaches draft/key before the fresh view and never writes automatically",async()=>{
  const input={...edge},key=scalar();let calls=0;
  const client=createPrivateMediaOwner(async(url)=>{calls++;assert.ok(String(url).endsWith("/view"));input.owner=other;key.fill(0);return Response.json(view);},()=>100);
  const row=await client.prepareGroupRow(object,scope,"object-set",input,owner,key);
  assert.equal(row.record.issuedAt,100);assert.equal(calls,1);assert.equal(parseForumAuthority("object-set",row.record)?.signer,owner);
  let tick=0;const stale=createPrivateMediaOwner(async()=>Response.json(view),()=>tick++*5);
  await assert.rejects(stale.prepareGroupRow(object,scope,"object-set",edge,owner,scalar()),PrivateMediaConflict);
  const wrong=createPrivateMediaOwner(async()=>Response.json({...view,owner:other}),()=>100);
  await assert.rejects(wrong.prepareGroupRow(object,scope,"object-set",edge,owner,scalar()));
  await assert.rejects(client.prepareGroupRow(object,scope,"object-set",edge,owner,scalar(),AbortSignal.abort()));
});
