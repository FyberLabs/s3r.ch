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
