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

test("granted catalog uses the held identity and discards rotation during its request",async()=>{
  unlock();const browser=createPrivateMediaBrowser(()=>owner,async(url)=>{
    assert.equal(String(url),"/api/media/catalog");return Response.json({at:100,objects:[],nextPage:1,principal:owner});
  });
  assert.deepEqual((await browser.grantedCatalog(0)).objects,[]);
  const changed=createPrivateMediaBrowser(()=>owner,async()=>{
    forgetUnlockedMeshPair();return Response.json({at:100,objects:[],nextPage:1,principal:owner});
  });
  await assert.rejects(changed.grantedCatalog(0));
});

test("next epoch preparation uses held identity and aborts on lock",async()=>{
  unlock();let calls=0;
  const context={at:100,fence:view.fence,snapshot:view.snapshot,owner,ownerPub:owner,previousEpoch:1,
    previousFinalizationId:"d".repeat(64),bindings:view.bindings};
  const input={deviceId:"browser",keyCommitment:"c".repeat(64),settleWindowMs:3600000};
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    calls++;assert.ok(String(url).endsWith("/epoch-view"));assert.deepEqual(JSON.parse(String(init?.body)),{object});
    return Response.json(context);
  });
  assert.equal((await browser.prepareNextEpoch(object,owner,input)).document.manifest.epoch,2);assert.equal(calls,1);
  const changing=createPrivateMediaBrowser(()=>owner,async()=>{forgetUnlockedMeshPair();return Response.json(context);});
  await assert.rejects(changing.prepareNextEpoch(object,owner,input));
});

const shareContext=(owner:string,reader:string,object:string)=>{
  const grants=[owner,reader].map(accessor=>({object,owner,accessor,from:100000,until:200000,stated:1,epoch:2,grantRevision:2,itemCiphertextDigest:"b".repeat(64)}));
  return {at:100,fence:"a".repeat(64),owner,ownerPub:owner,reader,previousEpoch:1,previousFinalizationId:"d".repeat(64),grants,
    snapshot:{entries:grants.map(g=>({accessor:g.accessor,grantRevision:g.grantRevision,stated:1,from:g.from,until:g.until,scope:"direct",setId:"",hamState:0}))},
    bindings:{[owner]:{pub:owner,epub:owner,head:0},[reader]:{pub:reader,epub:reader,head:0}}};
};

test("sharing preparation requires held identity throughout the request",async()=>{
  unlock();const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
  const context=shareContext(owner,reader,object);
  const browser=createPrivateMediaBrowser(()=>owner,async()=>Response.json(context));
  assert.equal((await browser.prepareShare(object,owner,reader)).grants.length,2);
  const changed=createPrivateMediaBrowser(()=>owner,async()=>{forgetUnlockedMeshPair();return Response.json(context);});
  await assert.rejects(changed.prepareShare(object,owner,reader));
});

test("sharing recovery uses a separate exclusive lock and refuses session changes",async()=>{
  const {IDBFactory}=await import("fake-indexeddb");
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator"),oldDb=Object.getOwnPropertyDescriptor(globalThis,"indexedDB");
  const names:string[]=[],expected={object,reader:other,token:"a".repeat(64)};let calls=0;
  try {
    Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:new IDBFactory()});
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
    unlock();const browser=createPrivateMediaBrowser(()=>owner,async()=>{calls++;forgetUnlockedMeshPair();return Response.json(view);});
    assert.equal(await browser.pendingShare(tenant),null);
    await browser.abandonShare(tenant,expected);
    await assert.rejects(browser.resumeShare(tenant,expected),/No pending/);
    await assert.rejects(browser.share(tenant,{object,owner,reader:other}));assert.equal(calls,1);
    assert.deepEqual(names,Array(3).fill(["s3rch-private-group-item-wrap-v1","s3rch-private-share-v1"]).flat());
    unlock();Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(_name:unknown,_options:unknown,work:(lock:unknown)=>unknown)=>work(null)}}});
    await assert.rejects(browser.resumeShare(tenant,expected),/another tab/);assert.equal(calls,1);
  } finally {
    if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);else Reflect.deleteProperty(globalThis,"navigator");
    if(oldDb)Object.defineProperty(globalThis,"indexedDB",oldDb);else Reflect.deleteProperty(globalThis,"indexedDB");
  }
});

test("member consent uses the unlocked key and preserves session guards",async()=>{
  unlock();const at=Math.floor(Date.now()/1000),scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
  const consent={at,fence:view.fence,consent:{memberPub:owner,
    state:{...scope,member:owner,setOwner:owner,memberAssent:null,setAssent:{stated:1,hamState:1,cancels:[]},cancels:[],stated:0},
    draft:{role:"member",...scope,member:owner,setOwner:owner,hamState:2,issuedAt:at,cancels:[]}}};
  let writes=0,applied=false;
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
    if(String(url).endsWith("group-consent-view"))return Response.json(consent);
    if(String(url).endsWith("group-consent-check"))return Response.json({at,fence:view.fence,state:applied?"applied":"absent"});
    writes++;applied=true;return Response.json({applied:true});
  });
  const row=await browser.prepareGroupConsent(object,scope,owner,1);
  assert.equal(row.record.member,owner);assert.equal(row.record.role,"member");
  assert.equal((await browser.groupConsentState(object,scope,owner,row)).state,"absent");
  await browser.appendGroupConsent(object,scope,owner,row);await browser.appendGroupConsent(object,scope,owner,row);assert.equal(writes,1);
  const changed=createPrivateMediaBrowser(()=>owner,async()=>{forgetUnlockedMeshPair();return Response.json(consent);});
  await assert.rejects(changed.prepareGroupConsent(object,scope,owner,1));
});

test("durable member consent uses its own lock and survives a lost write reply",async()=>{
  const {IDBFactory}=await import("fake-indexeddb");
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator"),oldDb=Object.getOwnPropertyDescriptor(globalThis,"indexedDB");
  try {
    unlock();Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:new IDBFactory()});
    const names:string[]=[];
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
    const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};let applied=false,writes=0;
    const browser=createPrivateMediaBrowser(()=>owner,async(url)=>{
      const at=Math.floor(Date.now()/1000);
      if(String(url).endsWith("view"))return Response.json({at,fence:view.fence,consent:{memberPub:owner,state:{...scope,member:owner,setOwner:owner,memberAssent:null,setAssent:{stated:1,hamState:1,cancels:[]},cancels:[],stated:0},draft:{role:"member",...scope,member:owner,setOwner:owner,hamState:2,issuedAt:at,cancels:[]}}});
      if(String(url).endsWith("check"))return Response.json({at,fence:view.fence,state:applied?"applied":"absent"});
      writes++;applied=true;throw Error("lost reply");
    });
    assert.equal(await browser.pendingConsent(tenant),null);
    await assert.rejects(browser.consent(tenant,{object,scope,member:owner,stated:1}));
    const pending=(await browser.pendingConsent(tenant))!;
    await browser.resumeConsent(tenant,pending);assert.equal(writes,1);
    assert.equal(await browser.pendingConsent(tenant),null);
    applied=false;await assert.rejects(browser.consent(tenant,{object,scope,member:owner,stated:1}));
    await browser.discardConsent(tenant,(await browser.pendingConsent(tenant))!);
    assert.equal(await browser.pendingConsent(tenant),null);assert.ok(names.every(n=>n==="s3rch-private-group-consent-v1"));
  } finally {
    if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);else Reflect.deleteProperty(globalThis,"navigator");
    if(oldDb)Object.defineProperty(globalThis,"indexedDB",oldDb);else Reflect.deleteProperty(globalThis,"indexedDB");
  }
});

test("group commands sign with the unlocked identity and stop when it locks",async()=>{
  unlock();const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
  let applied=false,writes=0,lockOnRead=false;
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
    const action=String(url).split("/").at(-1),body=JSON.parse(String(init?.body)),at=Math.floor(Date.now()/1000);
    assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
    if(lockOnRead)forgetUnlockedMeshPair();
    if(action==="create-view")return Response.json({at,fence:view.fence,context:{owner,ownerPub:owner,predicate:scope.predicate,setId:scope.set}});
    if(action==="member-view")return Response.json({at,fence:view.fence,signerPub:owner,draft:{...body,setOwner:owner,hamState:1,issuedAt:at,cancels:[]}});
    if(action?.endsWith("state"))return Response.json({at,state:applied?"applied":"absent",...(action==="member-state"||!applied?{fence:view.fence}:{})});
    writes++;applied=true;return Response.json({accepted:true});
  });
  const create=await browser.prepareGroupCreation(owner,object,scope,3600000);
  assert.equal((await browser.groupCommandState(owner,create)).state,"absent");
  await browser.applyGroupCommand(owner,create);await browser.applyGroupCommand(owner,create);assert.equal(writes,1);
  applied=false;
  const member=await browser.prepareGroupMembership(owner,scope,other,"set",1);
  await browser.applyGroupCommand(owner,member);assert.equal(writes,2);
  lockOnRead=true;
  await assert.rejects(browser.groupCommandState(owner,member));
  unlock();await assert.rejects(browser.prepareGroupCreation(owner,object,scope,3600000));
  unlock();await assert.rejects(browser.prepareGroupMembership(owner,scope,other,"set",1));
  unlock();await assert.rejects(browser.applyGroupCommand(owner,member));assert.equal(writes,2);
});

test("durable group commands use an exclusive lock and reconcile a lost response",async()=>{
  const {IDBFactory}=await import("fake-indexeddb");
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator"),oldDb=Object.getOwnPropertyDescriptor(globalThis,"indexedDB");
  try {
    unlock();Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:new IDBFactory()});
    const names:string[]=[];
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
    const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};let applied=false,writes=0;
    const browser=createPrivateMediaBrowser(()=>owner,async(url)=>{
      const at=Math.floor(Date.now()/1000),action=String(url).split("/").at(-1);
      if(action==="create-view")return Response.json({at,fence:view.fence,context:{owner,ownerPub:owner,predicate:scope.predicate,setId:scope.set}});
      if(action==="create-state")return Response.json({at,state:applied?"applied":"absent",...(!applied?{fence:view.fence}:{})});
      writes++;applied=true;throw Error("lost response");
    });
    assert.equal(await browser.pendingGroupCommand(tenant,owner),null);
    const command=await browser.prepareGroupCreation(owner,object,scope,3600000);
    await assert.rejects(browser.runGroupCommand(tenant,owner,command));
    const pending=await browser.pendingGroupCommand(tenant,owner);assert.ok(pending);
    await browser.resumeGroupCommand(tenant,owner,pending);assert.equal(writes,1);
    assert.equal(await browser.pendingGroupCommand(tenant,owner),null);
    applied=false;await assert.rejects(browser.runGroupCommand(tenant,owner,command));
    const next=await browser.pendingGroupCommand(tenant,owner);assert.ok(next);
    assert.deepEqual(await browser.discardGroupCommand(tenant,owner,next),{applied:true});
    assert.ok(names.every(name=>name==="s3rch-private-group-command-v1"));
    forgetUnlockedMeshPair();await assert.rejects(browser.pendingGroupCommand(tenant,owner));
  } finally {
    if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);else Reflect.deleteProperty(globalThis,"navigator");
    if(oldDb)Object.defineProperty(globalThis,"indexedDB",oldDb);else Reflect.deleteProperty(globalThis,"indexedDB");
  }
});

test("group catalog rejects identity lock during the response",async()=>{
 unlock();let lock=false;const result={at:Math.floor(Date.now()/1000),groups:[],nextPage:1,principal:owner};
 const browser=createPrivateMediaBrowser(()=>owner,async()=>{if(lock)forgetUnlockedMeshPair();return Response.json(result);});
 assert.deepEqual(await browser.groupCatalog(owner),result);
 lock=true;await assert.rejects(browser.groupCatalog(owner));
});

test("group key browser operations share a lock and retain encrypted recovery across replies",async()=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 try{
  unlock();Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  const names:string[]=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
  const scope={predicate:'same-group' as const,set:object.replace('media_','set_')};let command:any,payload='',applied=false,lose=true;
  const snapshot={predicate:scope.predicate,setId:scope.set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:pair.epub,ownerIdentityHead:0,
   members:[{accessor:owner,stated:1,hamState:1,signingPub:owner,encryptionPub:pair.epub,identityHead:0}]};
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
   const body=JSON.parse(String(init?.body)),at=Math.floor(Date.now()/1000),action=String(url).split('/').at(-1);
   assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
   if(action==='allocate')return Response.json({...scope,accepted:true});
   if(action==='key-view')return Response.json({at,fence:view.fence,previousEpoch:0,previousFinalizationId:'',snapshot,
    config:{owner,setId:scope.set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:'1'.repeat(128)}});
   if(action==='key-state')return Response.json({at,state:applied?'applied':'absent',fence:view.fence});
   if(action==='key-append'){command=body.command;applied=true;if(lose){lose=false;throw Error('lost');}return Response.json({accepted:true});}
   if(action==='wrap-view')return Response.json({at,fence:view.fence,snapshot,manifest:command.document.manifest});
   if(action==='wrap-publish'){payload=body.payload;return Response.json({digest:body.metadata.digest});}
   return Response.json({payload,predicate:scope.predicate,set_id:scope.set,epoch:1,revision_id:command.document.manifest.revisionId,
    reader_epub:pair.epub,key_commitment:command.document.manifest.keyCommitment,expires_at:at+2});
  });
  await assert.rejects(browser.startGroupKey(tenant,owner,scope));
  const pending=(await browser.pendingGroupKey(tenant,owner))!;assert.equal(pending.phase,'prepared');
  await assert.rejects(browser.startGroupKey(tenant,owner,scope));await assert.rejects(browser.discardGroupKey(tenant,owner,pending));
  const admitted=await browser.resumeGroupKey(tenant,owner,pending);assert.equal(admitted.phase,'admitted');
  const published=await browser.resumeGroupKey(tenant,owner,admitted);assert.equal(published.published,1);
  await browser.finishGroupKey(tenant,owner,published);assert.equal(await browser.pendingGroupKey(tenant,owner),null);
  assert.ok(names.every(name=>name==='s3rch-private-group-key-v1'||name==='s3rch-private-group-item-wrap-v1'));
  forgetUnlockedMeshPair();await assert.rejects(browser.pendingGroupKey(tenant,owner));
 }finally{
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else Reflect.deleteProperty(globalThis,'indexedDB');
 }
});

test("group item grants retain exact encrypted recovery under the unlocked identity",async()=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 try{
  unlock();Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  const names:string[]=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
  const target={object,predicate:'same-group' as const,set:object.replace('media_','set_'),reader:other,withdraw:false};
  let applied=false,lock=false,writes=0,views=0;const bodies:unknown[]=[];
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
   const body=JSON.parse(String(init?.body)),at=Math.floor(Date.now()/1000),action=String(url).split('/').at(-1);
   assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
   if(action==='item-grant-view'){
    views++;if(lock)forgetUnlockedMeshPair();
    return Response.json({at,fence:view.fence,ownerPub:owner,grant:{...grant,accessor:other,epoch:2,from:at*1000,until:(at+7200)*1000,stated:body.withdraw?0:1}});
   }
   if(action==='item-grant-state'){bodies.push(body.payload);return Response.json({at,state:applied?'applied':'absent',frozen:false});}
   bodies.push(body.payload);writes++;applied=true;throw Error('lost append reply');
  });
  assert.equal(await browser.pendingItemGrant(tenant,owner),null);
  await assert.rejects(browser.startItemGrant(tenant,owner,target));
  const pending=(await browser.pendingItemGrant(tenant,owner))!;assert.equal(pending.reader,other);
  await assert.rejects(browser.startItemGrant(tenant,owner,target));assert.equal(views,1);
  const result=await browser.resumeItemGrant(tenant,owner,pending);assert.equal(result.state,'applied');
  assert.equal(writes,1);assert.equal(await browser.pendingItemGrant(tenant,owner),null);
  assert.ok(bodies.every(body=>JSON.stringify(body)===JSON.stringify(bodies[0])));
  applied=false;await assert.rejects(browser.startItemGrant(tenant,owner,{...target,withdraw:true}));
  const cancelled=(await browser.pendingItemGrant(tenant,owner))!;assert.equal(cancelled.withdraw,true);
  assert.equal((await browser.discardItemGrant(tenant,owner,cancelled)).state,'applied');
  assert.ok(names.every(name=>name==='s3rch-private-group-item-grant-v1'||name==='s3rch-private-group-item-wrap-v1'));
  lock=true;await assert.rejects(browser.startItemGrant(tenant,owner,target));assert.equal(writes,2);
  await assert.rejects(browser.pendingItemGrant(tenant,owner));
  for(const priv of ['bad',pair.priv.slice(0,-1)+'F']){
   unlock();rememberUnlockedMeshPair('linked-credential',{...pair,priv});
   await assert.rejects(browser.startItemGrant(tenant,owner,target));
  }
 }finally{
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else Reflect.deleteProperty(globalThis,'indexedDB');
 }
});

test("group epoch adapter requires unlocked identity and uses its isolated journal",async()=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 try{
  unlock();Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  const names:string[]=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
  let calls=0;const browser=createPrivateMediaBrowser(()=>owner,async()=>{calls++;return new Response(null,{status:503});});
  const target={object,predicate:'same-group' as const,set:object.replace('media_','set_')};
  assert.equal(await browser.pendingItemEpoch(tenant,owner),null);
  await assert.rejects(browser.startItemEpoch(tenant,owner,target));assert.equal(calls,1);
  const expected={...target,epoch:2,token:'missing'};
  await assert.rejects(browser.resumeItemEpoch(tenant,owner,expected));
  await assert.rejects(browser.discardItemEpoch(tenant,owner,expected));
  assert.ok(names.every(name=>name==='s3rch-private-group-item-epoch-delivery-v1'||name==='s3rch-private-group-item-wrap-v1'));
  for(const priv of ['bad',pair.priv.slice(0,-1)+'F']){
   unlock();rememberUnlockedMeshPair('linked-credential',{...pair,priv});await assert.rejects(browser.startItemEpoch(tenant,owner,target));
  }
  forgetUnlockedMeshPair();await assert.rejects(browser.pendingItemEpoch(tenant,owner));
 }finally{
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else Reflect.deleteProperty(globalThis,'indexedDB');
 }
});

test("group item status session preserves signed recovery and isolates its lock",async()=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 try{
  unlock();Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  const names:string[]=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
  const target={object,predicate:'same-group' as const,set:object.replace('media_','set_'),reader:other};
  let applied=false,writes=0,views=0;
  const browser=createPrivateMediaBrowser(()=>owner,async(url,init)=>{
   const at=Math.floor(Date.now()/1000),action=String(url).split('/').at(-1);
   assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
   if(action==='item-status-view'){
    views++;return Response.json({at,fence:view.fence,ownerPub:owner,status:{object,epoch:2,revisionId:'b'.repeat(64),accessor:other,grantRevision:1,stated:1,
     signedAt:at*1000,maxAgeMs:60000,zookie:{object,objectVersion:3,snapshotHash:'c'.repeat(64)}}});
   }
   if(action==='item-status-state')return Response.json({at,state:applied?'applied':'absent'});
   writes++;applied=true;throw Error('lost append reply');
  });
  assert.equal(await browser.pendingItemStatus(tenant,owner),null);
  await assert.rejects(browser.startItemStatus(tenant,owner,target));const pending=(await browser.pendingItemStatus(tenant,owner))!;
  await assert.rejects(browser.startItemStatus(tenant,owner,target));assert.equal(views,1);
  assert.equal((await browser.resumeItemStatus(tenant,owner,pending)).state,'applied');assert.equal(writes,1);
  applied=false;await assert.rejects(browser.startItemStatus(tenant,owner,target));const second=(await browser.pendingItemStatus(tenant,owner))!;
  assert.equal((await browser.discardItemStatus(tenant,owner,second)).state,'applied');
  assert.ok(names.every(n=>n==='s3rch-private-group-item-status-v1'));
  for(const priv of ['bad',pair.priv.slice(0,-1)+'F']){
   unlock();rememberUnlockedMeshPair('linked-credential',{...pair,priv});await assert.rejects(browser.startItemStatus(tenant,owner,target));
  }
  forgetUnlockedMeshPair();await assert.rejects(browser.pendingItemStatus(tenant,owner));
 }finally{
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else Reflect.deleteProperty(globalThis,'indexedDB');
 }
});
test("group item wrap session uses dedicated recovery and refuses missing authority",async()=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 try{
  unlock();Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  const names:string[]=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,_options:unknown,work:(lock:unknown)=>unknown)=>{names.push(name);return work({});}}}});
  const target={object,predicate:'same-group' as const,set:object.replace('media_','set_'),reader:other};
  let calls=0;const browser=createPrivateMediaBrowser(()=>owner,async()=>{calls++;return new Response(null,{status:503});});
  assert.equal(await browser.pendingItemWrap(tenant,owner),null);await assert.rejects(browser.startItemWrap(tenant,owner,target));assert.equal(calls,1);
  await assert.rejects(browser.resumeItemWrap(tenant,owner,{...target,token:'missing'}));assert.equal(calls,1);
  assert.ok(names.every(n=>n==='s3rch-private-group-item-wrap-v1'));
  forgetUnlockedMeshPair();await assert.rejects(browser.pendingItemWrap(tenant,owner));await assert.rejects(browser.startItemWrap(tenant,owner,target));
 }finally{
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else Reflect.deleteProperty(globalThis,'indexedDB');
 }
});

test("saved delivery blocks conflicting browser mutations after a fresh session",async()=>{
 const {IDBFactory}=await import('fake-indexeddb');
 const {createShareJournal}=await import('./media-share-journal');
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 try{
  unlock();Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,_options:unknown,work:(lock:unknown)=>unknown)=>work({})}}});
  const journal=createShareJournal(undefined,'group-item-wrap'),signal=new AbortController().signal;
  const saved=await journal.write({tenant,object,encrypted:new Uint8Array([1]),sha256:'a'.repeat(64),wrap:{} as any},null,signal);
  let calls=0;const browser=createPrivateMediaBrowser(()=>owner,async()=>{calls++;throw Error('must not send');});
  const scope={predicate:'same-group' as const,set:object.replace('media_','set_')};
  await assert.rejects(browser.startGroupKey(tenant,owner,scope),/requires recovery/);
  await assert.rejects(browser.startItemEpoch(tenant,owner,{object,...scope}),/requires recovery/);
  await assert.rejects(browser.share(tenant,{object,owner,reader:other}),/requires recovery/);
  await assert.rejects(browser.resumeShare(tenant,{object,reader:other,token:'saved'}),/requires recovery/);
  assert.equal(calls,0);assert.deepEqual(await journal.read(signal),saved);
 }finally{
  if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else Reflect.deleteProperty(globalThis,'indexedDB');
 }
});
