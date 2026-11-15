// Cipher and HTTP contracts: executed in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { sealMediaFile } from "./media-file";
import { createPrivateMediaReader } from "./media-wrap-client";
const pub="YP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Y.eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk";
const epub="EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c";
const epriv="6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111";
const context={object,epoch:1,revisionId:"a".repeat(64)};
const plain=new TextEncoder().encode("private fixture"),description={name:"private.png",mediaType:"image/png"};
async function fixture(){
  const sealed=await sealMediaFile(plain,description,{tenant,object},context,[{account:pub,pub,identityPub:pub,epub}],[pub]);
  const reference={sha256:sealed.sha256,length:sealed.bytes.length};
  const wrapBase64=Buffer.from(JSON.stringify({reference,wrap:sealed.wraps[0]})).toString("base64");
  return {sealed,delivery:{context,readerEpub:epub,expiresAt:102,wrapBase64}};
}
test("fresh context surrounds download and decrypt, without sending reader keys",async()=>{
  const f=await fixture();let wraps=0;const order:string[]=[];
  const client=createPrivateMediaReader(async(url,init)=>{
    if(String(url)==="/api/media/read-wrap"){
      order.push("wrap");wraps++;assert.deepEqual(JSON.parse(String(init?.body)),{object});
      assert.equal(init?.credentials,"same-origin");return Response.json(f.delivery);
    }
    order.push("cipher");return new Response(new Uint8Array(f.sealed.bytes),{headers:{
      "content-type":"application/octet-stream","content-length":String(f.sealed.bytes.length),etag:`"${f.sealed.sha256}"`}});
  },()=>100);
  const opened=await client.open(object,tenant,epriv,epub);
  assert.deepEqual(opened.bytes,plain);assert.deepEqual(opened.description,description);
  assert.deepEqual(order,["wrap","cipher","wrap","wrap"]);assert.equal(wraps,3);
});
test("revocation and rotation at any authorization stage prevent plaintext delivery",async()=>{
  const f=await fixture();
  for(const stage of [1,2,3])for(const change of ["revoke","rotate","epoch","revision","expiry"]){
    let count=0;
    const client=createPrivateMediaReader(async(url)=>{
      if(String(url)==="/api/media/read-wrap"){
        count++;if(count===stage){
          if(change==="revoke")return new Response(null,{status:403});
          const changed=structuredClone(f.delivery);
          if(change==="rotate")changed.readerEpub="another-reader";
          if(change==="epoch")changed.context.epoch++;
          if(change==="revision")changed.context.revisionId="b".repeat(64);
          if(change==="expiry")changed.expiresAt=100;
          return Response.json(changed);
        }
        return Response.json(f.delivery);
      }
      return new Response(new Uint8Array(f.sealed.bytes),{headers:{"content-type":"application/octet-stream",
        "content-length":String(f.sealed.bytes.length),etag:`"${f.sealed.sha256}"`}});
    },()=>100);
    // The first context is only used for the reference; later current authority
    // may legitimately supersede it before any decryption starts.
    if(stage===1&&(change==="epoch"||change==="revision"))continue;
    await assert.rejects(client.open(object,tenant,epriv,epub));
  }
});
test("malformed private envelopes and cross-object context refuse before download",async()=>{
  const f=await fixture();
  for(const data of [null,[],{...f.delivery,extra:true},{...f.delivery,readerEpub:"other"},
    {...f.delivery,context:{...context,object:"other"}},{...f.delivery,wrapBase64:"!"},
    {...f.delivery,wrapBase64:Buffer.from("{}").toString("base64")},{...f.delivery,expiresAt:104}]){
    let calls=0;const client=createPrivateMediaReader(async()=>{calls++;return Response.json(data);},()=>100);
    await assert.rejects(client.open(object,tenant,epriv,epub));assert.equal(calls,1);
  }
  const client=createPrivateMediaReader(async()=>{throw Error("must not fetch");},()=>100);
  await assert.rejects(client.open("invalid",tenant,epriv,epub));
  const abort=new AbortController();abort.abort();await assert.rejects(client.open(object,tenant,epriv,epub,abort.signal));
});
test("Fetch-decoded compressed JSON remains bounded and readable",async()=>{
  const f=await fixture();
  for(const encoding of ["gzip","br"]){
    const client=createPrivateMediaReader(async(url)=>String(url)==="/api/media/read-wrap"
      ? Response.json(f.delivery,{headers:{"content-encoding":encoding}})
      : new Response(new Uint8Array(f.sealed.bytes),{headers:{"content-type":"application/octet-stream",
          "content-length":String(f.sealed.bytes.length),etag:`"${f.sealed.sha256}"`}}),()=>100);
    assert.deepEqual((await client.open(object,tenant,epriv,epub)).bytes,plain);
    const oversized=createPrivateMediaReader(async()=>new Response(" ".repeat(100001),{
      headers:{"content-type":"application/json","content-encoding":encoding}}),()=>100);
    await assert.rejects(oversized.open(object,tenant,epriv,epub));
  }
});

import {wrapGroupKeyToMembers} from "sociacl-ids/group-reader-wrap";
import {openGroupEpochWrap} from "sociacl-ids/group-wrap";
import {openItemDekReaderWrap} from "sociacl-ids";
import {uploadDigest} from "./media-upload-journal";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const groupScope={predicate:"same-group" as const,set:object.replace("media_","set_")};
async function groupFixture(){
  const f=await fixture(),key=new Uint8Array(32).fill(0x33),revision="b".repeat(64);
  const encrypted=await wrapGroupKeyToMembers(key,{group:groupScope.set,epoch:3,revisionId:revision},
    [{account:owner,pub,identityPub:pub,epub}],[owner]);
  assert.equal(encrypted.ok,true);if(!encrypted.ok)throw Error("fixture");
  const group={epoch:3,revisionId:revision,keyCommitment:await uploadDigest(key)};
  const joint={at:100,expiresAt:102,fence:"c".repeat(64),object,...groupScope,ownerPub:owner,
    item:{...context,digest:f.sealed.sha256},group};
  const {object:unused,...item}=joint.item;void unused;
  return {...f,key,joint:{...joint,item},groupDelivery:{predicate:groupScope.predicate,set_id:groupScope.set,epoch:3,revision_id:revision,
    reader_epub:epub,key_commitment:group.keyCommitment,expires_at:102,payload:Buffer.from(JSON.stringify(encrypted.value[0])).toString("base64")}};
}
test("group sharing wraps the current item key without returning or sending plaintext keys",async()=>{
  const f=await groupFixture();const order:string[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    const path=String(url);order.push(path);
    assert.ok(!String(init?.body).includes(epriv));
    if(path==="/api/media/read-wrap")return Response.json(f.delivery);
    if(path==="/api/media/groups/item-view")return Response.json(f.joint);
    if(path==="/api/media/groups/wrap-read")return Response.json(f.groupDelivery);
    return new Response(new Uint8Array(f.sealed.bytes),{headers:{"content-type":"application/octet-stream",
      "content-length":String(f.sealed.bytes.length),etag:`"${f.sealed.sha256}"`}});
  };
  const result=await createPrivateMediaReader(fetcher,()=>100).prepareGroupSharing(object,tenant,epriv,epub,owner,groupScope,new AbortController().signal);
  assert.deepEqual(Object.keys(result).sort(),["version","object","predicate","set","item","group","wrap","reference"].sort());
  assert.deepEqual(result.item,f.joint.item);assert.deepEqual(result.group,f.joint.group);
  const groupOpened=await openGroupEpochWrap(result.wrap,f.key,{object,group:groupScope.set,epoch:1,revisionId:context.revisionId});
  const direct=await openItemDekReaderWrap(f.sealed.wraps[0],epriv,epub,context);
  assert.equal(groupOpened.ok,true);assert.equal(direct.ok,true);
  if(groupOpened.ok&&direct.ok){assert.deepEqual(groupOpened.value,direct.value);groupOpened.value.fill(0);direct.value.fill(0);}
  assert.equal(order.filter(p=>p==="/api/media/groups/item-view").length,2);
  assert.equal(order.filter(p=>p==="/api/media/read-wrap").length,3);
});
test("group preparation refuses withdrawal, changed item/group context and corrupt ciphertext",async()=>{
  const f=await groupFixture();
  for(const change of ["withdraw","group-epoch","group-revision","group-key","item-epoch","item-revision","item-digest","owner-key","cipher","wrong-key"]){
    let reads=0;
    const fetcher:typeof fetch=async(url)=>{
      const path=String(url);
      if(path==="/api/media/read-wrap")return Response.json(f.delivery);
      if(path==="/api/media/groups/wrap-read")return Response.json(change==="wrong-key"?{...f.groupDelivery,key_commitment:"0".repeat(64)}:f.groupDelivery);
      if(path==="/api/media/groups/item-view"){
        reads++;if(reads===1)return Response.json(f.joint);
        if(change==="withdraw")return new Response(null,{status:403});
        const changed=structuredClone(f.joint);
        if(change==="group-epoch")changed.group.epoch++;
        if(change==="group-revision")changed.group.revisionId="e".repeat(64);
        if(change==="group-key")changed.group.keyCommitment="e".repeat(64);
        if(change==="item-epoch")changed.item.epoch++;
        if(change==="item-revision")changed.item.revisionId="e".repeat(64);
        if(change==="item-digest")changed.item.digest="e".repeat(64);
        if(change==="owner-key")changed.ownerPub=pub;
        return Response.json(changed);
      }
      const bytes=new Uint8Array(f.sealed.bytes);if(change==="cipher")bytes[bytes.length-1]^=1;
      return new Response(bytes,{headers:{"content-type":"application/octet-stream",
        "content-length":String(bytes.length),etag:`"${f.sealed.sha256}"`}});
    };
    await assert.rejects(createPrivateMediaReader(fetcher,()=>100).prepareGroupSharing(object,tenant,epriv,epub,owner,groupScope,new AbortController().signal));
  }
});
