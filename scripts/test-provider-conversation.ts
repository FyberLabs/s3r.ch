import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {build} from "esbuild";
import {chromium,type Browser} from "playwright-core";
import {fetchAtprotoConversation} from "../lib/atproto-conversation";
import {createPublicConversations} from "../lib/public-conversation";
import {conversationMediaTickets} from "../lib/conversation-media";
import {publicMediaSourceAdmission} from "../lib/public-media-sources";
import {threadAnchor,providerThread} from "./fixtures/provider-thread-data";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Provider conversation browser contracts run in CI only");
async function main(){
const bundle=await build({entryPoints:["scripts/fixtures/provider-conversation.tsx"],bundle:true,write:false,platform:"browser",format:"esm",jsx:"automatic",define:{"process.env.NODE_ENV":'"test"'}});
const key="fixture-only-key-".repeat(3);let rows=[threadAnchor],blocked=false,now=Date.now(),browser:Browser|undefined;
const load=createPublicConversations(anchor=>fetchAtprotoConversation(anchor,async()=>blocked?{thread:{$type:"app.bsky.feed.defs#blockedPost"}}:providerThread),()=>now);
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sH8AAAAASUVORK5CYII=","base64");
const server=createServer(async(req,res)=>{
 try{
  const path=req.url??"/";res.setHeader("cache-control","no-store");
  if(path==="/fixture/block"&&req.method==="POST"){blocked=true;now+=60_001;res.writeHead(204).end();return;}
  if(path==="/fixture/remove"&&req.method==="POST"){rows=[];res.writeHead(204).end();return;}
  if(path.startsWith("/api/feed/conversation?")){
   const conversation=await load(rows,"atproto",threadAnchor.id);if(!conversation){res.writeHead(404).end();return;}
   res.setHeader("content-type","application/json");res.end(JSON.stringify({...conversation,mediaTickets:conversationMediaTickets(key,threadAnchor,conversation)}));return;
  }
  if(path.startsWith("/api/feed/media?")){
   const sign=await publicMediaSourceAdmission(new Request("http://127.0.0.1"+path),key,async()=>rows,async()=>({available:true,streams:[]}));
   if(!sign){res.writeHead(403).end();return;}res.setHeader("content-type","image/png");res.end(png);return;
  }
  if(path==="/fixture.js"){res.setHeader("content-type","text/javascript");res.end(bundle.outputFiles[0].contents);return;}
  if(path==="/"){res.setHeader("content-type","text/html");res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');return;}
  res.writeHead(404).end();
 }catch{res.writeHead(500).end("fixture failure");}
});
try{
 server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage(),errors:string[]=[],external:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/*",route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin);await page.getByRole("button",{name:"Show conversation"}).click();await page.getByText("Provider parent",{exact:true}).waitFor();
 assert.deepEqual(await page.locator("article > p:nth-child(2)").allTextContents(),["Provider root","Provider parent","Public child","Provider reply"]);
 const picture=page.getByRole("img",{name:"Parent photo"}).first();await picture.waitFor();await page.waitForFunction(()=>Array.from(document.images).some(image=>image.alt==="Parent photo"&&image.naturalWidth>0));
 const media=await picture.getAttribute("src");assert.ok(media?.includes("context="));
 assert.equal((await page.request.get(origin+media)).status(),200);
 await page.getByRole("button",{name:"Hide conversation"}).click();await page.request.post(origin+"/fixture/block");await page.getByRole("button",{name:"Show conversation"}).click();await page.getByText("Post unavailable",{exact:true}).waitFor();
 assert.equal(await page.getByText("Provider parent",{exact:true}).count(),0);
 await page.request.post(origin+"/fixture/remove");assert.equal((await page.request.get(origin+media)).status(),403);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log("PASS provider parent/reply order, proxied ticketed image, blocked placeholder and anchor removal");
}finally{await browser?.close();server.close();}

}
void main().catch(error=>{console.error(error);process.exitCode=1;});
