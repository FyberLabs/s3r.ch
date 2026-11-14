// Browser identity, signature and HTTP contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateMediaBrowser } from "./media-browser-session";
import { rememberUnlockedMeshPair, forgetUnlockedMeshPair } from "./identity/unlocked-mesh";
import { signPrivateMediaEpoch } from "sociacl-ids/private-media";
import { sealMediaFile } from "./media-file";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
  epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111";
const view={at:100,fence:"a".repeat(64),snapshot:{entries:[]},objectVersion:0,owner,bindings:{[owner]:{pub:owner,epub:pair.epub,head:0}}};
const grant={object,owner,accessor:owner,from:0,until:200000,stated:1,epoch:1,grantRevision:1,itemCiphertextDigest:"b".repeat(64)};
function unlock(){forgetUnlockedMeshPair();rememberUnlockedMeshPair("linked-credential",pair);}
test.afterEach(()=>forgetUnlockedMeshPair());
test("requires one already unlocked identity matching the authenticated SEA session",async()=>{
  let calls=0;const browser=createPrivateMediaBrowser(()=>owner,async()=>{calls++;throw Error("unexpected");});
  forgetUnlockedMeshPair();await assert.rejects(browser.grant(object,owner,grant));
  unlock();rememberUnlockedMeshPair("another",{...pair,pub:other});await assert.rejects(browser.grant(object,owner,grant));
  unlock();await assert.rejects(createPrivateMediaBrowser(()=>other).grant(object,owner,grant));
  assert.equal(calls,0);
});
test("owner methods use the unlocked key without placing private fields on HTTP",async()=>{
  unlock();const operations:string[]=[];
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    const body=JSON.parse(String(init?.body));assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
    if(String(url).endsWith("/view"))return Response.json(view);
    if(String(url).endsWith("/status-view"))return Response.json({at:100,fence:view.fence,ownerPub:owner,status:{object,epoch:1,
      revisionId:"b".repeat(64),accessor:owner,grantRevision:1,stated:1,signedAt:100000,maxAgeMs:60000,
      zookie:{object,objectVersion:1,snapshotHash:"c".repeat(64)}}});
    if(String(url).endsWith("/publish-wrap"))return Response.json({record:body.metadata.digest,digest:body.metadata.digest});
    operations.push(body.operation);return Response.json({accepted:true});
  });
  await browser.grant(object,owner,grant);
  const draft={object,previousEpoch:0,epoch:1,deviceId:"browser",keyCommitment:"c".repeat(64),settleWindowMs:3600000};
  const scalar=new Uint8Array(32);scalar[31]=1;
  const revisionId=signPrivateMediaEpoch(draft,view.snapshot,scalar,owner).manifest.revisionId;scalar.fill(0);
  await browser.epoch(object,owner,draft,{object,epoch:1,previousEpoch:0,revisionId,candidateRevisionIds:[revisionId],previousFinalizationId:""});
  await browser.status(object,owner);
  await browser.publishWrap(object,owner,owner,{object,epoch:1,revisionId,scope:"item-dek",target:"reader-epub",targetId:pair.epub,wrappedKey:"00"},
    {sha256:"b".repeat(64),length:64});
  assert.deepEqual(operations,["grant","epoch","status"]);
});
test("lock, replacement, ambiguity and session change stop an in-flight write",async()=>{
  for(const change of [()=>forgetUnlockedMeshPair(),()=>rememberUnlockedMeshPair("linked-credential",{...pair}),
    ()=>rememberUnlockedMeshPair("other",{...pair,pub:other}),()=>{}]) {
    unlock();let calls=0,session:string|null=owner;let signal:AbortSignal|null|undefined;
    const browser=createPrivateMediaBrowser(()=>session,async(_url,init)=>{calls++;signal=init?.signal;change();session=null;return Response.json(view);});
    await assert.rejects(browser.grant(object,owner,grant));assert.equal(calls,1);assert.equal(signal?.aborted,true);
  }
  unlock();await assert.rejects(createPrivateMediaBrowser(()=>owner).grant(object,owner,grant,AbortSignal.abort()));
});
test("invalid scalar encodings refuse before transport and release subscriptions",async()=>{
  for(const priv of ["bad",pair.priv.slice(0,-1)+"F"]){
    unlock();rememberUnlockedMeshPair("linked-credential",{...pair,priv});let calls=0;
    await assert.rejects(createPrivateMediaBrowser(()=>owner,async()=>{calls++;throw Error("unexpected");}).grant(object,owner,grant));
    assert.equal(calls,0);forgetUnlockedMeshPair();
  }
});
test("private reads use unlocked encryption keys and return authenticated file bytes",async()=>{
  unlock();const plain=new TextEncoder().encode("private fixture"),context={object,epoch:1,revisionId:"a".repeat(64)};
  const sealed=await sealMediaFile(plain,{name:"image.png",mediaType:"image/png"},{tenant,object},context,
    [{account:owner,pub:owner,identityPub:owner,epub:pair.epub}],[owner]);
  const reference={sha256:sealed.sha256,length:sealed.bytes.length};
  const wrapBase64=Buffer.from(JSON.stringify({reference,wrap:sealed.wraps[0]})).toString("base64");
  const browser=createPrivateMediaBrowser(()=>owner,async(url)=>String(url)==="/api/media/read-wrap"
    ?Response.json({context,readerEpub:pair.epub,expiresAt:Date.now()/1000+2,wrapBase64})
    :new Response(new Uint8Array(sealed.bytes),{headers:{"content-type":"application/octet-stream","content-length":String(sealed.bytes.length),etag:`"${sealed.sha256}"`}}));
  const opened=await browser.open(object,tenant);assert.deepEqual(opened.bytes,plain);opened.bytes.fill(0);
});
test("session changes while consuming a write response refuse completion without replay",async()=>{
  unlock();let session:string|null=owner,calls=0;
  const browser=createPrivateMediaBrowser(()=>session,async()=>{
    if(++calls===1)return Response.json(view);
    return new Response(new ReadableStream({pull(controller){
      session=null;controller.enqueue(new TextEncoder().encode('{"accepted":true}'));controller.close();
    }},{highWaterMark:0}),{headers:{"content-type":"application/json"}});
  });
  await assert.rejects(browser.grant(object,owner,grant));assert.equal(calls,2);
});

test("catalog is private navigation bound to the unlocked session",async()=>{
  unlock();let calls=0;
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    calls++;assert.equal(String(url),"/api/media/owner/catalog");assert.deepEqual(JSON.parse(String(init?.body)),{page:0});
    return Response.json({at:1,objects:[object],nextPage:1,principal:owner});
  });
  assert.deepEqual(await browser.catalog(0),{at:1,objects:[object],nextPage:1,principal:owner});
  for(const page of [-1,16,0.5,NaN])await assert.rejects(browser.catalog(page));
  assert.equal(calls,1);
  const changing=createPrivateMediaBrowser(()=>owner,async()=>{forgetUnlockedMeshPair();return Response.json({at:1,objects:[object],nextPage:1,principal:owner});});
  await assert.rejects(changing.catalog(0));
});

// The key in the session can rotate while the canonical owner remains stable.
test("catalog preserves the protected stable principal after signing key rotation",async()=>{
  forgetUnlockedMeshPair();rememberUnlockedMeshPair("rotated",{...pair,pub:other});
  const result={at:1,objects:[object],nextPage:1,principal:owner};
  const browser=createPrivateMediaBrowser(()=>other,async()=>Response.json(result));
  assert.deepEqual(await browser.catalog(0),result);
});

test("recipient management and cancellation use the held signing key",async()=>{
  unlock();let writes=0;
  const entry={accessor:other,grantRevision:1,stated:1,from:0,until:200000,scope:"direct",setId:"",hamState:0};
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    if(String(url).endsWith("/view"))return Response.json({...view,snapshot:{entries:[entry]}});
    if(String(url).endsWith("/cancel-view"))return Response.json({at:100,fence:view.fence,ownerPub:owner,grant:{...grant,accessor:other,stated:0,grantRevision:2}});
    writes++;assert.equal(JSON.parse(String(init?.body)).payload.claims.stated,0);return Response.json({accepted:true});
  });
  assert.deepEqual(await browser.recipients(object,owner),[other]);await browser.cancel(object,other);assert.equal(writes,1);
});

test("allocation requires the unlocked session and refuses identity changes before confirmation",async()=>{
  const record={object,owner,issuedAt:100,sig:"signed"};let calls=0;
  unlock();
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    calls++;assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
    return Response.json(String(url).endsWith("/allocate")?{object,accepted:true}:view);
  });
  assert.deepEqual(await browser.allocate(record),{object});assert.equal(calls,2);
  forgetUnlockedMeshPair();await assert.rejects(browser.allocate(record));assert.equal(calls,2);
  unlock();let changedCalls=0;
  const changing=createPrivateMediaBrowser(()=>owner,async()=>{
    changedCalls++;forgetUnlockedMeshPair();return Response.json({object,accepted:true});
  });
  await assert.rejects(changing.allocate(record));assert.equal(changedCalls,1);
});

test("initial epoch uses the unlocked session and stops on identity replacement", async () => {
  unlock(); let calls = 0;
  const input = { deviceId: "browser", keyCommitment: "c".repeat(64), settleWindowMs: 3600000 };
  const browser = createPrivateMediaBrowser(() => owner, async (url, init) => {
    calls++;
    assert.ok(!String(init?.body).includes(pair.priv)); assert.ok(!String(init?.body).includes(pair.epriv));
    if (String(url).endsWith("/view")) return Response.json(view);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.payload.finalization.revisionId, body.payload.document.manifest.revisionId);
    return Response.json({ accepted: true });
  });
  assert.equal((await browser.initialEpoch(object, owner, input)).epoch, 1); assert.equal(calls, 2);
  calls = 0;
  const changing = createPrivateMediaBrowser(() => owner, async () => {
    calls++; forgetUnlockedMeshPair(); return Response.json(view);
  });
  await assert.rejects(changing.initialEpoch(object, owner, input)); assert.equal(calls, 1);
});

test("upload recovery wrappers require one unlocked identity and an exclusive browser lock",async()=>{
  const {IDBFactory}=await import("fake-indexeddb");
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator"),oldDb=Object.getOwnPropertyDescriptor(globalThis,"indexedDB");
  try {
    Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:new IDBFactory()});
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(_name:unknown,_options:unknown,work:(lock:unknown)=>unknown)=>work({})}}});
    unlock();const browser=createPrivateMediaBrowser(()=>owner);
    assert.equal(await browser.pendingUpload(tenant),null);await browser.discardUpload(tenant,"inspected-object");
    await assert.rejects(browser.upload(tenant),/No pending/);
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(_name:unknown,_options:unknown,work:(lock:unknown)=>unknown)=>work(null)}}});
    await assert.rejects(browser.discardUpload(tenant,"inspected-object"),/another tab/);
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{}});
    await assert.rejects(browser.upload(tenant),/cannot safely resume/);
  } finally {
    if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);else Reflect.deleteProperty(globalThis,"navigator");
    if(oldDb)Object.defineProperty(globalThis,"indexedDB",oldDb);else Reflect.deleteProperty(globalThis,"indexedDB");
  }
});

test("deletion uses the unlocked owner and refuses replay after identity changes",async()=>{
  unlock();let writes=0;
  const claims={tenant,object,owner,objectVersion:1,fence:view.fence,issuedAt:100000,expiresAt:160000};
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
    if(String(url).endsWith("/delete-view"))return Response.json({at:100,ownerPub:owner,claims});
    writes++;return Response.json({accepted:true,command:"f".repeat(64),cleanup:"pending"});
  });
  const intent=await browser.prepareDeletion(tenant,object,owner);assert.equal(writes,0);
  await browser.submitDeletion(intent);assert.equal(writes,1);
  await assert.rejects(browser.submitDeletion({...intent,ownerPub:other}));assert.equal(writes,1);
  forgetUnlockedMeshPair();await assert.rejects(browser.submitDeletion(intent));assert.equal(writes,1);
});
