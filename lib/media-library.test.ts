// Session HTTP and browser state contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { tagMemePng } from "./meme-png-tags";
import { createMediaLibrary, type MediaLibraryState } from "./media-library";
import { createPrivateMediaBrowser } from "./media-browser-session";
import { rememberUnlockedMeshPair, forgetUnlockedMeshPair } from "./identity/unlocked-mesh";
const key="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const pair={pub:key,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:key,epriv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"};
function setup(overrides: Partial<Parameters<typeof createMediaLibrary>[1]> = {}) {
  let state: MediaLibraryState|undefined;
  const bytes=new Uint8Array([1,2,3]), revoked:string[]=[], pages:number[]=[];
  const browser: typeof createPrivateMediaBrowser=()=>({
    catalog:async(page:number)=>{pages.push(page);return {at:1,objects:["owned"],nextPage:page===15?null:page+1,principal:key};},
    status:async()=>{},open:async()=>({description:{name:"image.png",mediaType:"image/png"},bytes}),
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>);
  const library=createMediaLibrary(value=>{state=value;},{clock:()=>0,browser,
    fetcher:async(url,init)=>{assert.equal(String(url),"/api/identity/sea/session");assert.equal(init?.cache,"no-store");
      return Response.json({enabled:true,principal:key,expiresAt:100000});},
    makeUrl:blob=>{assert.equal(blob.type,"image/png");return "blob:private";},revokeUrl:url=>{revoked.push(url);},...overrides});
  return {library,state:()=>state!,bytes,revoked,pages};
}
test.afterEach(()=>forgetUnlockedMeshPair());
test("catalog pagination and image bytes stay in temporary browser state",async()=>{
  const item=setup();
  try {
    await item.library.open("unknown","tenant");assert.deepEqual(item.pages,[]);
    await item.library.load();assert.deepEqual(item.state().objects,["owned"]);assert.equal(item.state().nextPage,1);
    await item.library.open("owned","tenant");assert.deepEqual([...item.bytes],[0,0,0]);
    assert.deepEqual(item.state().preview,{url:"blob:private",name:"image.png",mediaType:"image/png",tags:[]});
    await item.library.load(15);assert.deepEqual(item.revoked,["blob:private"]);assert.equal(item.state().nextPage,null);
    item.library.reset();assert.equal(item.state().loaded,false);assert.deepEqual(item.state().objects,[]);
  } finally {item.library.dispose();}
});
test("unavailable or malformed sessions clear all private state",async()=>{
  for(const response of [new Response("private",{status:403}),new Response("not json"),
    Response.json(null),Response.json({enabled:false}),Response.json({enabled:true,principal:"bad",expiresAt:1000}),
    Response.json({enabled:true,principal:key,expiresAt:0}),Response.json({enabled:true,principal:key,expiresAt:300001})]) {
    const item=setup({fetcher:async()=>response});
    try {await item.library.load();assert.equal(item.state().loaded,false);assert.equal(item.state().busy,false);
      assert.match(item.state().message,/unavailable/);assert.deepEqual(item.pages,[]);
    } finally {item.library.dispose();}
  }
});
test("identity changes revoke previews and discard a late decrypted result",async()=>{
  const item=setup();
  try {
    await item.library.load();await item.library.open("owned","tenant");
    rememberUnlockedMeshPair("test",pair);assert.deepEqual(item.revoked,["blob:private"]);assert.deepEqual(item.state().objects,[]);
  } finally {item.library.dispose();}
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});const bytes=new Uint8Array([9]);
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  const delayed=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),
    status:async()=>{},open:async()=>{started();await pending;return {description:{name:"x.png",mediaType:"image/png"},bytes};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await delayed.library.load();const opening=delayed.library.open("owned","tenant");await began;
    delayed.library.reset();release();await opening;assert.equal(bytes[0],0);assert.equal(delayed.state().preview,null);
  } finally {release();delayed.library.dispose();}
});
test("busy and disposed controllers do not start duplicate operations",async()=>{
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  const item=setup({fetcher:async()=>{await waiting;return Response.json({enabled:true,principal:key,expiresAt:100000});}});
  const first=item.library.load();await item.library.load(1);item.library.dispose();release();await first;
  await item.library.load();item.library.dispose();assert.deepEqual(item.pages,[]);
});
test("unsupported content is not given a preview URL and its plaintext is cleared",async()=>{
  const bytes=new Uint8Array([5]);const item=setup({browser:()=>({
    catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),
    status:async()=>{},open:async()=>({description:{name:"unsafe.html",mediaType:"text/html"},bytes}),
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>),makeUrl:()=>{throw Error("must not render");}});
  try {await item.library.load();await item.library.open("owned","tenant");assert.equal(bytes[0],0);
    assert.equal(item.state().preview,null);assert.match(item.state().message,/cannot be previewed/);
  } finally {item.library.dispose();}
});
test("expired session clears an existing preview before another operation",async()=>{
  let now=0;const item=setup({clock:()=>now});
  try {await item.library.load();await item.library.open("owned","tenant");now=100001;
    await item.library.load();assert.deepEqual(item.revoked,["blob:private"]);assert.equal(item.state().loaded,false);
  } finally {item.library.dispose();}
});

test("session timer clears loaded private navigation",async()=>{
  const item=setup({fetcher:async()=>Response.json({enabled:true,principal:key,expiresAt:10})});
  try {await item.library.load();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(item.state().loaded,false);assert.match(item.state().message,/expired/);
  } finally {item.library.dispose();}
});
test("default browser adapter refuses a locked identity",async()=>{
  forgetUnlockedMeshPair();let state:MediaLibraryState|undefined;
  const library=createMediaLibrary(value=>{state=value;},{clock:()=>0,
    fetcher:async()=>Response.json({enabled:true,principal:key,expiresAt:1000})});
  try {await library.load();assert.equal(state?.loaded,false);assert.match(state!.message,/unavailable/);}
  finally {library.dispose();}
});

test("sharing management only cancels listed recipients and does not retry writes",async()=>{
  let writes=0;const item=setup({browser:()=>({
    catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),
    recipients:async(object:string,owner:string)=>{assert.equal(object,"owned");assert.equal(owner,key);return [key,"recipient"];},
    cancel:async(object:string,reader:string)=>{assert.equal(object,"owned");assert.equal(reader,"recipient");writes++;},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await item.library.recipients("unknown");await item.library.cancel("owned",key);assert.equal(writes,0);
    await item.library.load();await item.library.recipients("owned");assert.deepEqual(item.state().audience,{object:"owned",readers:["recipient"]});
    await item.library.cancel("owned",key);await item.library.cancel("other",key);await item.library.cancel("owned","other");assert.equal(writes,0);
    await item.library.cancel("owned","recipient");assert.equal(writes,1);assert.equal(item.state().audience,null);
    assert.match(item.state().message,/Sharing stopped/);await item.library.cancel("owned","recipient");assert.equal(writes,1);
  } finally {item.library.dispose();}
});

test("audio and video previews use temporary URLs and zero plaintext",async()=>{
  for(const mediaType of ["audio/ogg","video/mp4"]) {
    const bytes=new Uint8Array([5]);let created=0;const item=setup({browser:()=>({
      catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),
      status:async()=>{},open:async()=>({description:{name:"clip",mediaType},bytes}),
    } as unknown as ReturnType<typeof createPrivateMediaBrowser>),makeUrl:blob=>{assert.equal(blob.type,mediaType);created++;return "blob:clip";}});
    try {await item.library.load();await item.library.open("owned","tenant");assert.equal(created,1);assert.equal(bytes[0],0);
      assert.equal(item.state().preview?.mediaType,mediaType);item.library.reset();assert.deepEqual(item.revoked,["blob:clip"]);
    } finally {item.library.dispose();}
  }
});

test("decrypted PNG tags live only with the preview and clear on identity change",async()=>{
  const bytes=tagMemePng(new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=","base64")),[" Team ","demo"]);
  const item=setup({browser:()=>({
    catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
    status:async()=>{},open:async()=>({description:{name:"meme.png",mediaType:"image/png"},bytes}),
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await item.library.load();await item.library.open("owned","tenant");
    assert.deepEqual(item.state().preview?.tags,["team","demo"]);
    assert.ok(bytes.every(value=>value===0));
    rememberUnlockedMeshPair("test",pair);
    assert.equal(item.state().preview,null);assert.deepEqual(item.revoked,["blob:private"]);
  }finally{item.library.dispose();}
});

test("deletion requires confirmation and retries the same prepared intent",async()=>{
  let prepared=0,submitted=0;const intent={object:"owned"};
  const item=setup({browser:()=>({
    catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
    prepareDeletion:async()=>{prepared++;return intent;},
    submitDeletion:async(value:unknown)=>{assert.equal(value,intent);if(++submitted===1)throw Error("lost response");},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    item.library.requestDeletion("unknown");await item.library.confirmDeletion("tenant");assert.equal(prepared,0);
    await item.library.load();item.library.requestDeletion("owned");assert.equal(prepared,0);
    await item.library.load();await item.library.open("owned","tenant");assert.deepEqual(item.state().objects,["owned"]);
    item.library.cancelDeletion();assert.equal(item.state().deletion,null);assert.equal(submitted,0);
    item.library.requestDeletion("owned");await item.library.confirmDeletion("tenant");
    assert.equal(item.state().deletion?.prepared,true);assert.match(item.state().message,/same request/);
    await item.library.confirmDeletion("tenant");assert.equal(prepared,1);assert.equal(submitted,2);
    assert.deepEqual(item.state().objects,[]);assert.equal(item.state().deletion,null);
    assert.match(item.state().message,/cleanup is pending/);
  }finally{item.library.dispose();}
});

test("identity reset discards an in-flight deletion without submitting it",async()=>{
  let release!:(value:unknown)=>void,started!:()=>void,submitted=0;
  const pending=new Promise(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
  const item=setup({browser:()=>({
    catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
    prepareDeletion:async()=>{started();return pending;},submitDeletion:async()=>{submitted++;},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await item.library.load();item.library.requestDeletion("owned");const deleting=item.library.confirmDeletion("tenant");
    await began;item.library.reset();release({object:"owned"});await deleting;
    assert.equal(submitted,0);assert.equal(item.state().deletion,null);assert.deepEqual(item.state().objects,[]);
  }finally{release({});item.library.dispose();}
});

test("deletion preparation failure permits retry without claiming acceptance",async()=>{
  const item=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
    prepareDeletion:async()=>{throw Error("denied");},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {await item.library.load();item.library.requestDeletion("owned");await item.library.confirmDeletion("tenant");
    assert.equal(item.state().deletion?.prepared,false);assert.match(item.state().message,/could not be prepared/);
  }finally{item.library.dispose();}
});

test("temporary session failure retains the original deletion intent without submitting",async()=>{
  let requests=0,prepared=0,submitted=0;const intent={object:"owned"};
  const item=setup({fetcher:async()=>{
    requests++;if(requests===3)return new Response("unavailable",{status:503});
    if(requests===4)return new Response(new ReadableStream({start(controller){controller.error(Error("connection lost"));}}),{headers:{"content-type":"application/json"}});
    return Response.json({enabled:true,principal:key,expiresAt:100000});
  },browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
    prepareDeletion:async()=>{prepared++;return intent;},
    submitDeletion:async(value:unknown)=>{assert.equal(value,intent);if(++submitted===1)throw Error("lost");},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {await item.library.load();item.library.requestDeletion("owned");await item.library.confirmDeletion("tenant");
    await item.library.confirmDeletion("tenant");assert.equal(submitted,1);assert.equal(item.state().deletion?.prepared,true);
    await item.library.confirmDeletion("tenant");assert.equal(submitted,1);assert.equal(item.state().deletion?.prepared,true);
    await item.library.confirmDeletion("tenant");assert.equal(submitted,2);assert.equal(prepared,1);
  }finally{item.library.dispose();}
});

test("pending cleanup survives an unknown result and clears only after confirmation",async()=>{
  const command="a".repeat(64),calls:string[]=[];let fail=true;
  const item=setup({browser:()=>({
    cleanupCatalog:async(page:number)=>({at:1,objects:[{object:"owned",command}],nextPage:page===15?null:page+1,principal:key}),
    cleanup:async(object:string,held:string)=>{calls.push(object+held);if(fail)throw Error("unknown");return {command,cleanup:"complete"};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await item.library.cleanup("owned",command);assert.deepEqual(calls,[]);
    await item.library.loadCleanup(15);assert.equal(item.state().cleanup?.nextPage,null);
    await item.library.cleanup("owned","wrong");assert.deepEqual(calls,[]);
    await item.library.cleanup("owned",command);assert.equal(calls.length,1);assert.equal(item.state().cleanup?.objects.length,1);
    assert.match(item.state().message,/could not be confirmed/);
    fail=false;await item.library.cleanup("owned",command);assert.equal(calls.length,2);assert.deepEqual(item.state().cleanup?.objects,[]);
    item.library.reset();assert.equal(item.state().cleanup,null);
  }finally{item.library.dispose();}
});
test("identity reset discards late cleanup navigation",async()=>{
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
  const item=setup({browser:()=>({cleanupCatalog:async()=>{started();await gate;return {at:1,objects:[{object:"owned",command:"a".repeat(64)}],nextPage:1,principal:key};}
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    const loading=item.library.loadCleanup();await began;item.library.reset();release();await loading;
    assert.equal(item.state().cleanup,null);assert.equal(item.state().busy,false);
  }finally{release();item.library.dispose();}
});

test("granted navigation opens without owner signing and never enables owner controls",async()=>{
  let statuses=0,opens=0;const bytes=new Uint8Array([1,2,3]);
  const item=setup({browser:()=>({
    grantedCatalog:async(page:number)=>({at:1,objects:["shared"],nextPage:page===15?null:page+1,principal:key}),
    status:async()=>{statuses++;},open:async()=>{opens++;return {description:{name:"shared.png",mediaType:"image/png"},bytes};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await item.library.loadGranted();assert.deepEqual(item.state().granted?.objects,["shared"]);
    item.library.requestDeletion("shared");assert.equal(item.state().deletion,null);
    await item.library.recipients("shared");assert.equal(item.state().audience,null);
    await item.library.open("shared","tenant");assert.equal(opens,1);assert.equal(statuses,0);
    assert.deepEqual([...bytes],[0,0,0]);assert.ok(item.state().preview);
    await item.library.loadGranted(15);assert.equal(item.state().granted?.nextPage,null);
    item.library.reset();assert.equal(item.state().granted,null);assert.equal(item.state().preview,null);
  } finally {item.library.dispose();}
});
test("revoked granted delivery clears the catalog and old previews",async()=>{
  const item=setup({browser:()=>({
    grantedCatalog:async()=>({at:1,objects:["shared"],nextPage:1,principal:key}),
    open:async()=>{throw Error("revoked");},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await item.library.loadGranted();await item.library.open("shared","tenant");
    assert.equal(item.state().granted,null);assert.equal(item.state().preview,null);
    assert.match(item.state().message,/unavailable/);
  } finally {item.library.dispose();}
});


test("sharing UI scopes targets to owned selection and resumes only saved changes",async()=>{
  const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
  const calls:unknown[]=[];let waiting=true;
  const f=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),
    recipients:async()=>[],pendingShare:async()=>waiting?{object:"owned",reader,token:"token"}:null,
    share:async(_tenant:string,target:unknown)=>{calls.push(target);return {object:"owned",reader,token:"token",pending:waiting};},
    resumeShare:async(_tenant:string,expected:unknown)=>{calls.push(expected);return {object:"owned",reader,token:"token",pending:waiting};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await f.library.load();await f.library.share("tenant","owned",reader);assert.equal(calls.length,0);
    await f.library.recipients("owned");await f.library.share("tenant","owned","bad");assert.equal(calls.length,0);
    await f.library.share("tenant","owned",reader);assert.deepEqual(calls,[{object:"owned",owner:key,reader}]);
    assert.equal(f.state().sharing?.reader,reader);assert.match(f.state().message,/not yet confirmed/);
    waiting=false;await f.library.resumeSharing("tenant");assert.deepEqual(calls[1],{object:"owned",reader,token:"token"});assert.equal(f.state().sharing,null);
    await f.library.inspectSharing("tenant");assert.match(f.state().message,/No pending/);
    waiting=true;await f.library.inspectSharing("tenant");assert.equal(f.state().sharing?.reader,reader);
    f.library.reset();assert.equal(f.state().sharing,null);
  } finally {f.library.dispose();}
});

test("failed new sharing cannot label or resume a different saved recipient",async()=>{
  const saved={object:"older-file",reader:key,token:"saved-token"};const calls:unknown[]=[];
  const recipient="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
  const f=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),recipients:async()=>[],
    share:async()=>{throw Error("existing draft");},pendingShare:async()=>saved,
    resumeShare:async(_tenant:string,expected:unknown)=>{calls.push(expected);return {...saved,pending:true};},
    abandonShare:async(_tenant:string,expected:unknown)=>{calls.push(expected);},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await f.library.load();await f.library.recipients("owned");await f.library.share("tenant","owned",recipient);
    assert.equal(f.state().sharing,null);await f.library.resumeSharing("tenant");assert.equal(calls.length,0);
    await f.library.inspectSharing("tenant");assert.deepEqual(f.state().sharing,saved);
    await f.library.resumeSharing("tenant");assert.deepEqual(calls[0],saved);
    await f.library.abandonSharing("tenant");assert.deepEqual(calls[1],saved);assert.equal(f.state().sharing,null);
    assert.match(f.state().message,/not undone/);
  } finally {f.library.dispose();}
});

test("unshare UI uses recoverable removal and preserves the selected operation",async()=>{
  const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
  const calls:unknown[]=[];
  const f=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:1,principal:key}),recipients:async()=>[reader],
    share:async(_tenant:string,target:unknown)=>{calls.push(target);return {object:"owned",reader,token:"saved",remove:true,pending:true};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
  try {
    await f.library.load();await f.library.unshare("tenant","owned",reader);assert.equal(calls.length,0);
    await f.library.recipients("owned");await f.library.unshare("tenant","owned",reader);
    assert.deepEqual(calls,[{object:"owned",owner:key,reader,remove:true}]);assert.equal(f.state().sharing?.remove,true);
    assert.match(f.state().message,/Removal is saved/);
  } finally {f.library.dispose();}
});

test("room reference uses current file authorization without a catalog and refuses noncanonical locators",async()=>{
 const object='media_p_7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1_22222222222222222222222222222222';let opens=0;
 const bytes=new Uint8Array([7]);const item=setup({browser:()=>({open:async(id:string)=>{
   assert.equal(id,object);opens++;if(opens>1)throw Error("revoked");return {description:{name:"clip.wav",mediaType:"audio/wav"},bytes};
 }} as unknown as ReturnType<typeof createPrivateMediaBrowser>),makeUrl:()=>"blob:clip"});
 try {
   await item.library.openReference("https://example.test/clip","tenant");assert.equal(opens,0);
   await item.library.openReference(object,"tenant");assert.equal(opens,1);assert.equal(item.state().preview?.url,"blob:clip");assert.equal(bytes[0],0);
   await item.library.openReference(object,"tenant");assert.equal(opens,2);assert.equal(item.state().preview,null);assert.deepEqual(item.revoked,["blob:clip"]);
 }finally{item.library.dispose();}
});

test("decrypted audio tags follow the private preview and disappear on reset",async()=>{
  const bytes=new Uint8Array([1,2]);const item=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
    status:async()=>{},open:async()=>({description:{name:"voice.wav",mediaType:"audio/wav",tags:["team"]},bytes}),
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>),makeUrl:()=>"blob:audio"});
  try {await item.library.load();await item.library.open("owned","tenant");assert.deepEqual(item.state().preview?.tags,["team"]);
    assert.deepEqual([...bytes],[0,0]);item.library.reset();assert.equal(item.state().preview,null);assert.deepEqual(item.revoked,["blob:audio"]);
  }finally{item.library.dispose();}
});

test("saved group responses preserve exact selection and report recovery without granting access",async()=>{
 const saved={object:"owned",member:key,scope:{predicate:"same-group" as const,set:"set_test"},stated:1 as const,token:"token"};
 let pending:typeof saved|null=saved,fail=false,applied=true;const calls:unknown[]=[];
 const f=setup({browser:()=>({pendingConsent:async()=>pending,
  resumeConsent:async(_tenant:string,expected:unknown)=>{calls.push(expected);if(fail)throw Error("lost");},
  discardConsent:async(_tenant:string,expected:unknown)=>{calls.push(expected);if(fail)throw Error("unavailable");return {applied};},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try {
  await f.library.resumeConsent("tenant");await f.library.discardConsent("tenant");assert.equal(calls.length,0);
  await f.library.inspectConsent("tenant");assert.deepEqual(f.state().consent,saved);
  fail=true;await f.library.resumeConsent("tenant");assert.deepEqual(f.state().consent,saved);assert.match(f.state().message,/retained/);
  await f.library.discardConsent("tenant");assert.deepEqual(f.state().consent,saved);assert.match(f.state().message,/cannot be cleared/);
  fail=false;await f.library.resumeConsent("tenant");assert.equal(f.state().consent,null);assert.match(f.state().message,/checked separately/);
  await f.library.inspectConsent("tenant");await f.library.discardConsent("tenant");assert.match(f.state().message,/already accepted/);
  applied=false;await f.library.inspectConsent("tenant");await f.library.discardConsent("tenant");assert.match(f.state().message,/does not undo/);
  assert.ok(calls.every(value=>JSON.stringify(value)===JSON.stringify(saved)));
  pending=null;await f.library.inspectConsent("tenant");assert.equal(f.state().consent,null);assert.match(f.state().message,/No saved/);
  pending=saved;await f.library.inspectConsent("tenant");f.library.reset();assert.equal(f.state().consent,null);
 } finally {f.library.dispose();}
});
test("identity reset discards a delayed group recovery result",async()=>{
 let release!:(value:unknown)=>void;
 const saved={object:"owned",member:key,scope:{predicate:"same-group",set:"set_test"},stated:0,token:"token"};
 const f=setup({browser:()=>({pendingConsent:()=>new Promise(resolve=>{release=resolve;})} as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try {
  const work=f.library.inspectConsent("tenant");while(!release)await new Promise(resolve=>setImmediate(resolve));
  f.library.reset("Identity changed");release(saved);await work;assert.equal(f.state().consent,null);assert.equal(f.state().message,"Identity changed");
 } finally {f.library.dispose();}
});

test("independent group recovery binds the catalog principal and preserves failed requests",async()=>{
 const saved={kind:"create" as const,set:"set_test",principal:key,token:"saved"};
 let pending:typeof saved|null=saved,fail=false,applied=true;const calls:unknown[]=[];
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:[],nextPage:null,principal:key}),
  pendingGroupCommand:async(_tenant:string,principal:string)=>{assert.equal(principal,key);return pending;},
  resumeGroupCommand:async(_tenant:string,principal:string,expected:unknown)=>{assert.equal(principal,key);calls.push(expected);if(fail){pending={...saved,token:"renewed"};throw Error("lost");}},
  discardGroupCommand:async(_tenant:string,principal:string,expected:unknown)=>{assert.equal(principal,key);calls.push(expected);if(fail)throw Error("offline");return {applied};},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try {
  await f.library.inspectGroupCommand("tenant");await f.library.resumeGroupCommand("tenant");await f.library.discardGroupCommand("tenant");assert.equal(calls.length,0);
  await f.library.load();await f.library.inspectGroupCommand("tenant");assert.deepEqual(f.state().groupCommand,saved);
  fail=true;await f.library.resumeGroupCommand("tenant");assert.equal(f.state().groupCommand,null);assert.match(f.state().message,/Check the saved group change again/);
  const count=calls.length;await f.library.resumeGroupCommand("tenant");await f.library.discardGroupCommand("tenant");assert.equal(calls.length,count);
  await f.library.inspectGroupCommand("tenant");assert.equal(f.state().groupCommand?.token,"renewed");
  await f.library.discardGroupCommand("tenant");assert.equal(f.state().groupCommand?.token,"renewed");assert.match(f.state().message,/cannot be cleared/);
  fail=false;await f.library.resumeGroupCommand("tenant");assert.equal(f.state().groupCommand,null);assert.match(f.state().message,/checked separately/);
  await f.library.inspectGroupCommand("tenant");await f.library.discardGroupCommand("tenant");assert.match(f.state().message,/already accepted/);
  applied=false;await f.library.inspectGroupCommand("tenant");await f.library.discardGroupCommand("tenant");assert.match(f.state().message,/not undone/);
  assert.deepEqual(calls[0],saved);assert.ok(calls.slice(1).every(value=>(value as {token:string}).token==="renewed"));
  pending=null;await f.library.inspectGroupCommand("tenant");assert.match(f.state().message,/No saved/);
  pending=saved;await f.library.inspectGroupCommand("tenant");f.library.reset();assert.equal(f.state().groupCommand,null);
 }finally{f.library.dispose();}
});
test("identity reset discards delayed independent group recovery",async()=>{
 let release!:(value:unknown)=>void;
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:[],nextPage:null,principal:key}),
  pendingGroupCommand:()=>new Promise(resolve=>{release=resolve;})} as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try {
  await f.library.load();const work=f.library.inspectGroupCommand("tenant");while(!release)await new Promise(resolve=>setImmediate(resolve));
  f.library.reset("Identity changed");release({kind:"create",set:"set_test",principal:key,token:"saved"});await work;
  assert.equal(f.state().groupCommand,null);assert.equal(f.state().message,"Identity changed");
 }finally{f.library.dispose();}
});

test("group invitations and withdrawals use durable member-only commands",async()=>{
 const entry={predicate:"same-group" as const,set:"set_test",owner:key,owned:true,invited:true,active:false};
 let active=false,saved=false,fail=false;const calls:unknown[]=[];
 const command={kind:"member",body:{}};
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:[],nextPage:null,principal:key}),
  groupCatalog:async(principal:string,page:number)=>{assert.equal(principal,key);return {at:1,principal:key,groups:[{...entry,active}],nextPage:page<15?page+1:null};},
  pendingGroupCommand:async()=>saved?{token:"pending"}:null,
  prepareGroupMembership:async(...args:unknown[])=>{calls.push(args.slice(0,5));return command;},
  runGroupCommand:async(tenant:string,principal:string,value:unknown)=>{assert.equal(tenant,"tenant");assert.equal(principal,key);assert.equal(value,command);if(fail)throw Error("lost");},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try {
  await f.library.loadGroups();await f.library.respondToGroup("tenant",entry.set,entry.predicate,1);assert.equal(calls.length,0);
  await f.library.load();await f.library.loadGroups();assert.equal(f.state().groups?.nextPage,1);
  await f.library.respondToGroup("tenant","unknown",entry.predicate,1);await f.library.respondToGroup("tenant",entry.set,entry.predicate,0);assert.equal(calls.length,0);
  await f.library.respondToGroup("tenant",entry.set,entry.predicate,1);
  assert.deepEqual(calls[0],[key,{set:entry.set,predicate:entry.predicate},key,"member",1]);assert.equal(f.state().groups,null);assert.match(f.state().message,/checked separately/);
  active=true;await f.library.loadGroups(15);assert.equal(f.state().groups?.nextPage,null);
  await f.library.respondToGroup("tenant",entry.set,entry.predicate,1);assert.equal(calls.length,1);
  await f.library.respondToGroup("tenant",entry.set,entry.predicate,0);assert.match(f.state().message,/withdrawal was accepted/);
  await f.library.loadGroups();fail=true;await f.library.respondToGroup("tenant",entry.set,entry.predicate,0);assert.equal(f.state().groups,null);assert.match(f.state().message,/Check the saved group change/);
  await f.library.loadGroups();saved=true;const count=calls.length;await f.library.respondToGroup("tenant",entry.set,entry.predicate,0);assert.equal(calls.length,count);
  await f.library.loadGroups();f.library.reset();assert.equal(f.state().groups,null);
 }finally{f.library.dispose();}
});

test("group owners create empty groups and sign only their invitation role",async()=>{
 const member="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
 const entry={predicate:"same-group" as const,set:"set_test",owner:key,owned:true,invited:false,active:false};
 const calls:unknown[][]=[];let saved=false,fail=false,owned=true;
 const command={kind:"create",body:{}};
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:["owned"],nextPage:null,principal:key}),
  groupCatalog:async()=>({at:1,principal:key,groups:[{...entry,owned}],nextPage:1}),pendingGroupCommand:async()=>saved?{token:"saved"}:null,
  prepareGroupCreation:async(...args:unknown[])=>{calls.push(args.slice(0,4));return command;},
  prepareGroupMembership:async(...args:unknown[])=>{calls.push(args.slice(0,5));return command;},
  runGroupCommand:async()=>{if(fail)throw Error("lost");},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try {
  await f.library.createGroup("tenant");assert.equal(calls.length,0);
  await f.library.load();await f.library.createGroup("tenant");
  assert.equal(calls[0][0],key);assert.equal(calls[0][1],"owned");assert.equal(calls[0][3],86400000);
  assert.match((calls[0][2] as {set:string}).set,/^set_p_/);assert.match(f.state().message,/No files have been shared/);
  await f.library.inviteToGroup("tenant",entry.set,entry.predicate,member,1);assert.equal(calls.length,1);
  await f.library.loadGroups();await f.library.inviteToGroup("tenant",entry.set,entry.predicate,"bad",1);assert.equal(calls.length,1);
  await f.library.inviteToGroup("tenant",entry.set,entry.predicate,member,1);
  assert.deepEqual(calls[1],[key,{set:entry.set,predicate:entry.predicate},member,"set",1]);assert.match(f.state().message,/must also consent/);
  await f.library.loadGroups();await f.library.inviteToGroup("tenant",entry.set,entry.predicate,member,0);assert.match(f.state().message,/withdrawal was accepted/);
  owned=false;await f.library.loadGroups();const count=calls.length;await f.library.inviteToGroup("tenant",entry.set,entry.predicate,member,1);assert.equal(calls.length,count);
  fail=true;await f.library.createGroup("tenant");assert.match(f.state().message,/Check the saved group change/);
  owned=true;await f.library.loadGroups();await f.library.inviteToGroup("tenant",entry.set,entry.predicate,member,1);assert.match(f.state().message,/Check the saved group change/);
  saved=true;const held=calls.length;await f.library.createGroup("tenant");await f.library.loadGroups();await f.library.inviteToGroup("tenant",entry.set,entry.predicate,member,1);assert.equal(calls.length,held);
 }finally{f.library.dispose();}
});

test("group key controls require active ownership and preserve recoverable failures",async()=>{
 const entry={predicate:"same-group" as const,set:"set_test",owner:key,owned:true,invited:true,active:true};
 let held:any={set:entry.set,principal:key,token:'saved',epoch:1,revisionId:'a'.repeat(64),phase:'admitted',published:0,total:0};
 let active=false,fail=false,calls=0;
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:['owned'],nextPage:null,principal:key}),
  groupCatalog:async()=>({at:1,principal:key,groups:[{...entry,active}],nextPage:1}),
  startGroupKey:async()=>{calls++;if(fail)throw Error();return held;},pendingGroupKey:async()=>held,
  resumeGroupKey:async()=>{if(fail)throw Error();return held={...held,published:1,total:1};},
  finishGroupKey:async()=>{if(fail)throw Error();},discardGroupKey:async()=>{if(fail)throw Error();},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try{
  await f.library.startGroupKey('tenant',entry.set,entry.predicate);assert.equal(calls,0);
  await f.library.load();await f.library.loadGroups();await f.library.startGroupKey('tenant',entry.set,entry.predicate);assert.equal(calls,0);
  active=true;await f.library.loadGroups();await f.library.startGroupKey('tenant',entry.set,entry.predicate);assert.equal(calls,1);
  assert.equal(f.state().groupKey?.phase,'admitted');await f.library.discardGroupKey('tenant');assert.ok(f.state().groupKey);
  fail=true;await f.library.resumeGroupKey('tenant');assert.equal(f.state().groupKey,null);assert.match(f.state().message,/remain saved/);
  await f.library.inspectGroupKey('tenant');fail=false;await f.library.resumeGroupKey('tenant');assert.equal(f.state().groupKey?.published,1);
  fail=true;await f.library.finishGroupKey('tenant');assert.ok(f.state().groupKey);assert.match(f.state().message,/retained/);
  fail=false;await f.library.finishGroupKey('tenant');assert.equal(f.state().groupKey,null);
  held={...held,phase:'prepared'};await f.library.inspectGroupKey('tenant');fail=true;await f.library.discardGroupKey('tenant');assert.ok(f.state().groupKey);
  fail=false;await f.library.discardGroupKey('tenant');assert.equal(f.state().groupKey,null);
  fail=true;await f.library.startGroupKey('tenant',entry.set,entry.predicate);assert.match(f.state().message,/Check saved group keys/);
  held=null;await f.library.inspectGroupKey('tenant');assert.match(f.state().message,/No saved/);
  f.library.reset();assert.equal(f.state().groupKey,null);
 }finally{f.library.dispose();}
});

test("group item controls preserve recovery and distinguish recorded permission from delivery",async()=>{
 const held={object:'owned',predicate:'same-group',set:'set_test',reader:key,withdraw:false,token:'saved'};
 let saved:typeof held|null=held,fail=false,frozen=false,calls=0;
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:['owned'],nextPage:null,principal:key}),
  recipients:async()=>[],pendingItemGrant:async()=>saved,
  startItemGrant:async(_tenant:string,_owner:string,target:{withdraw:boolean})=>{calls++;if(fail)throw Error();return {state:'applied',frozen};},
  resumeItemGrant:async(_tenant:string,_owner:string,expected:typeof held)=>{assert.deepEqual(expected,saved);if(fail)throw Error();return {state:'applied',frozen};},
  discardItemGrant:async()=>{if(fail)throw Error();return {state:'absent',frozen:false};},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try{
  await f.library.startItemGrant('tenant','owned','same-group','set_test',key,false);assert.equal(calls,0);
  await f.library.inspectItemGrant('tenant');await f.library.resumeItemGrant('tenant');await f.library.discardItemGrant('tenant');
  await f.library.load();await f.library.recipients('owned');
  for(const [object,set,reader] of [['other','set_test',key],['owned','',key],['owned','set_test','bad']])await f.library.startItemGrant('tenant',object,'same-group',set,reader,false);
  assert.equal(calls,0);
  await f.library.startItemGrant('tenant','owned','same-group','set_test',key,false);assert.match(f.state().message,/delivery still needs/);
  await f.library.startItemGrant('tenant','owned','same-group','set_test',key,true);assert.match(f.state().message,/permission withdrawn/);
  frozen=true;await f.library.startItemGrant('tenant','owned','same-group','set_test',key,false);assert.match(f.state().message,/frozen/);
  fail=true;await f.library.startItemGrant('tenant','owned','same-group','set_test',key,false);assert.match(f.state().message,/Check its saved request/);
  await f.library.inspectItemGrant('tenant');assert.deepEqual(f.state().itemGrant,held);
  const before=calls;await f.library.startItemGrant('tenant','owned','same-group','set_test',key,false);assert.equal(calls,before);
  await f.library.resumeItemGrant('tenant');assert.deepEqual(f.state().itemGrant,held);assert.match(f.state().message,/retained/);
  await f.library.discardItemGrant('tenant');assert.deepEqual(f.state().itemGrant,held);assert.match(f.state().message,/cannot be cleared/);
  fail=false;await f.library.resumeItemGrant('tenant');assert.equal(f.state().itemGrant,null);assert.match(f.state().message,/frozen/);
  frozen=false;await f.library.inspectItemGrant('tenant');await f.library.resumeItemGrant('tenant');assert.match(f.state().message,/delivery still needs/);
  saved={...held,withdraw:true};await f.library.inspectItemGrant('tenant');await f.library.resumeItemGrant('tenant');assert.match(f.state().message,/withdrawal confirmed/);
  await f.library.inspectItemGrant('tenant');await f.library.discardItemGrant('tenant');assert.equal(f.state().itemGrant,null);assert.match(f.state().message,/not undone/);
  saved=null;await f.library.inspectItemGrant('tenant');assert.match(f.state().message,/No saved/);
  saved=held;await f.library.inspectItemGrant('tenant');f.library.requestDeletion('owned');
  await f.library.inspectItemGrant('tenant');await f.library.resumeItemGrant('tenant');await f.library.discardItemGrant('tenant');assert.deepEqual(f.state().itemGrant,held);
  f.library.reset();assert.equal(f.state().itemGrant,null);
 }finally{f.library.dispose();}
});

test("late group permission recovery cannot restore private state after reset",async()=>{
 let release!:(value:any)=>void;const waiting=new Promise(resolve=>{release=resolve;});
 let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:['owned'],nextPage:null,principal:key}),
  pendingItemGrant:async()=>{began();return await waiting;},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try{
  await f.library.load();const work=f.library.inspectItemGrant('tenant');await started;f.library.reset();
  release({object:'owned',predicate:'same-group',set:'set_test',reader:key,withdraw:false,token:'saved'});
  await work;assert.equal(f.state().itemGrant,null);assert.equal(f.state().loaded,false);
 }finally{release(null);f.library.dispose();}
});

test("group access controls preserve uncertain updates and never claim file delivery",async()=>{
 const held={object:'owned',predicate:'same-group',set:'set_test',epoch:2,token:'saved'};
 let saved:typeof held|null=held,fail=false,calls=0;
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:['owned'],nextPage:null,principal:key}),
  recipients:async()=>[],pendingItemEpoch:async()=>saved,
  startItemEpoch:async()=>{calls++;if(fail)throw Error();return {state:'applied'};},
  resumeItemEpoch:async(_tenant:string,_owner:string,expected:typeof held)=>{assert.deepEqual(expected,saved);if(fail)throw Error();return {state:'applied'};},
  discardItemEpoch:async()=>{if(fail)throw Error();return {state:'absent'};},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try{
  await f.library.startItemEpoch('tenant','owned','same-group','set_test');assert.equal(calls,0);
  await f.library.inspectItemEpoch('tenant');await f.library.resumeItemEpoch('tenant');await f.library.discardItemEpoch('tenant');
  await f.library.load();await f.library.recipients('owned');
  for(const [object,set] of [['other','set_test'],['owned','']])await f.library.startItemEpoch('tenant',object,'same-group',set);
  assert.equal(calls,0);await f.library.startItemEpoch('tenant','owned','same-group','set_test');assert.match(f.state().message,/delivery still needs/);
  fail=true;await f.library.startItemEpoch('tenant','owned','same-group','set_test');assert.match(f.state().message,/Check its saved request/);
  await f.library.inspectItemEpoch('tenant');assert.deepEqual(f.state().itemEpoch,held);
  const before=calls;await f.library.startItemEpoch('tenant','owned','same-group','set_test');assert.equal(calls,before);
  await f.library.resumeItemEpoch('tenant');assert.deepEqual(f.state().itemEpoch,held);assert.match(f.state().message,/retained/);
  await f.library.discardItemEpoch('tenant');assert.deepEqual(f.state().itemEpoch,held);assert.match(f.state().message,/cannot be cleared/);
  fail=false;await f.library.resumeItemEpoch('tenant');assert.equal(f.state().itemEpoch,null);assert.match(f.state().message,/delivery still needs/);
  await f.library.inspectItemEpoch('tenant');await f.library.discardItemEpoch('tenant');assert.equal(f.state().itemEpoch,null);assert.match(f.state().message,/not undone/);
  saved=null;await f.library.inspectItemEpoch('tenant');assert.match(f.state().message,/No saved/);
  saved=held;await f.library.inspectItemEpoch('tenant');f.library.requestDeletion('owned');
  await f.library.inspectItemEpoch('tenant');await f.library.resumeItemEpoch('tenant');await f.library.discardItemEpoch('tenant');assert.deepEqual(f.state().itemEpoch,held);
  f.library.reset();assert.equal(f.state().itemEpoch,null);
 }finally{f.library.dispose();}
});
test("late group access recovery cannot restore state after reset",async()=>{
 let release!:(value:any)=>void;const waiting=new Promise(resolve=>{release=resolve;});
 let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
 const f=setup({browser:()=>({catalog:async()=>({at:1,objects:['owned'],nextPage:null,principal:key}),
  pendingItemEpoch:async()=>{began();return await waiting;},
 } as unknown as ReturnType<typeof createPrivateMediaBrowser>)});
 try{
  await f.library.load();const work=f.library.inspectItemEpoch('tenant');await started;f.library.reset();
  release({object:'owned',predicate:'same-group',set:'set_test',epoch:2,token:'saved'});
  await work;assert.equal(f.state().itemEpoch,null);assert.equal(f.state().loaded,false);
 }finally{release(null);f.library.dispose();}
});
