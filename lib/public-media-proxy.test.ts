import test from "node:test";
import assert from "node:assert/strict";
import { readMediaBytes, rewriteMediaPlaylist, servePublicMedia } from "./public-media-proxy";
const request=(kind="image",url="https://example.com/a") => new Request(`https://s3r.ch/api/feed/media?${new URLSearchParams({kind,url})}`);
test("proxy refuses private destinations before transport",async()=>{
  let calls=0;
  const response=await servePublicMedia(request("image","http://127.0.0.1/a"),async()=>{calls++;throw Error();});
  assert.equal(response.status,400);assert.equal(calls,0);
});
test("proxy refuses wrong content type and strips upstream credentials",async()=>{
  assert.equal((await servePublicMedia(request(),async()=>new Response("<html>",{headers:{"content-type":"text/html"}}))).status,415);
  const response=await servePublicMedia(request(),async()=>new Response(new Uint8Array([1,2]),{headers:{"content-type":"image/png","set-cookie":"secret=1"}}));
  assert.equal(response.status,200);assert.equal(response.headers.get("set-cookie"),null);assert.equal(response.headers.get("x-content-type-options"),"nosniff");
});
test("body bounds declared and streamed bytes",async()=>{
  await assert.rejects(readMediaBytes(new Response("12345"),4),/large/);
  await assert.rejects(readMediaBytes(new Response("1",{headers:{"content-length":"5"}}),4),/large/);
  assert.deepEqual(await readMediaBytes(new Response("1234"),4),new TextEncoder().encode("1234"));
});
test("HLS child URLs stay on proxy and private keys/URLs refuse",()=>{
  const output=rewriteMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment.ts',"https://example.com/video/master.m3u8",0);
  assert.match(output,/URI="\/api\/feed\/media\?/);assert.match(output,/url=https%3A%2F%2Fexample.com%2Fvideo%2Fsegment.ts/);
  assert.throws(()=>rewriteMediaPlaylist('#EXTM3U\nhttp://127.0.0.1/a',"https://example.com/a",0));
  assert.throws(()=>rewriteMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"',"https://example.com/a",0));
  assert.throws(()=>rewriteMediaPlaylist('#EXTM3U\na.m3u8',"https://example.com/a",3));
});
test("bounded queue serves waiting attachments and removes abandoned callers",async()=>{
 const {createMediaQueue}=await import("./public-media-proxy");
 const acquire=createMediaQueue(1,1,1000),signal=new AbortController().signal;
 const release=await acquire(signal);assert.ok(release);
 const second=acquire(signal);assert.equal(await acquire(signal),null);
 release();const releaseSecond=await second;assert.ok(releaseSecond);releaseSecond();
 const controller=new AbortController(),held=await acquire(signal);assert.ok(held);
 const abandoned=acquire(controller.signal);controller.abort();assert.equal(await abandoned,null);held();
});
test("HLS audio segments are accepted and manifests cannot be cached stale",async()=>{
 for(const type of ["audio/aac","audio/mpeg"]){
  const response=await servePublicMedia(request("video"),async()=>new Response("segment",{headers:{"content-type":type}}));
  assert.equal(response.status,200);
 }
 const response=await servePublicMedia(request("video"),async()=>new Response("#EXTM3U\nsegment.ts",{headers:{"content-type":"application/vnd.apple.mpegurl"}}));
 assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
});
test("proxy rejects malformed kinds, depths, cross-site loads and upstream failures",async()=>{
 assert.equal((await servePublicMedia(request("html"))).status,400);
 assert.equal((await servePublicMedia(new Request(request().url+"&depth=99"))).status,400);
 assert.equal((await servePublicMedia(new Request(request().url,{headers:{"sec-fetch-site":"cross-site"}}))).status,403);
 assert.equal((await servePublicMedia(request(),async()=>{throw Error("offline");})).status,502);
 assert.equal((await servePublicMedia(request(),async()=>new Response(null,{status:404}))).status,415);
});
test("body reader cancels empty, malformed and stalled responses",async()=>{
 await assert.rejects(readMediaBytes(new Response(null),8),/Empty/);
 await assert.rejects(readMediaBytes(new Response(""),8),/Empty/);
 await assert.rejects(readMediaBytes(new Response("1",{headers:{"content-length":"bad"}}),8),/large/);
 let cancelled=false;
 const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
 await assert.rejects(readMediaBytes(response,8,5),/timeout|Empty/);assert.equal(cancelled,true);
});
test("playlist refuses malformed attributes, excessive size and unsafe URI-bearing tags",()=>{
 for(const text of ["invalid","#EXTM3U\n"+"x".repeat(8193),"#EXTM3U\n"+"\n".repeat(2048),'#EXTM3U\n#EXT-X-SESSION-DATA:URI="data"','#EXTM3U\n#EXT-X-MAP:URI=bad','#EXTM3U\n#EXT-X-MAP:URI="a",URI="b"'])assert.throws(()=>rewriteMediaPlaylist(text,"https://example.com/a",0));
 assert.match(rewriteMediaPlaylist("#EXTM3U\n\n#EXT-X-ENDLIST","https://example.com/a",0),/#EXT-X-ENDLIST/);
});
test("queue expires waiters and refuses already aborted callers",async()=>{
 const {createMediaQueue}=await import("./public-media-proxy");
 const acquire=createMediaQueue(1,1,5),controller=new AbortController();controller.abort();
 assert.equal(await acquire(controller.signal),null);
 const signal=new AbortController().signal,release=await acquire(signal);assert.ok(release);
 assert.equal(await acquire(signal),null);release();
});
