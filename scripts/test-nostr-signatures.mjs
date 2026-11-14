import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {once} from "node:events";
import {schnorr} from "@noble/curves/secp256k1.js";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Nostr browser signature contracts run in CI only");
const key=new Uint8Array(32);key[31]=4;
const pubkey=Buffer.from(schnorr.getPublicKey(key)).toString("hex"),now=1800000000;
const raw={pubkey,created_at:123,kind:1,tags:[],content:"A signed public note"};
const hash=createHash("sha256").update(JSON.stringify([0,pubkey,123,1,[],raw.content])).digest();
const event={...raw,id:hash.toString("hex"),sig:Buffer.from(schnorr.sign(hash,key,new Uint8Array(32))).toString("hex")};
const bundle=await build({stdin:{contents:"import {verifiedNostrEvent} from './lib/nostr-event'; window.verify=verifiedNostrEvent;",resolveDir:process.cwd(),loader:"ts"},bundle:true,write:false,platform:"browser",format:"iife"});
let browser;const server=createServer((req,res)=>{
 if(req.url==="/fixture.js"){res.setHeader("content-type","text/javascript");res.end(bundle.outputFiles[0].contents);return;}
 res.setHeader("content-type","text/html");res.end('<!doctype html><script src="/fixture.js"></script>');
});
try{
 server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));await page.goto(origin);
 assert.deepEqual(await page.evaluate(({event,pubkey,now})=>window.verify(event,[pubkey],1,now),{event,pubkey,now}),event);
 for(const changed of [{...event,content:"forged"},{...event,id:"0".repeat(64)},{...event,sig:"0".repeat(128)},{...event,pubkey:"0".repeat(64)},{...event,kind:30311}])assert.equal(await page.evaluate(({event,pubkey,now})=>window.verify(event,[pubkey],1,now),{event:changed,pubkey,now}),null);
 assert.deepEqual(errors,[]);console.log("PASS browser WebCrypto Nostr authentication rejects forged notes");
}finally{await browser?.close();server.close();}
