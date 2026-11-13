import assert from "node:assert/strict";
import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Public media browser contracts run in CI only");
const result=await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import PublicFeedMedia from './components/PublicFeedMedia'; createRoot(document.getElementById('root')).render(<PublicFeedMedia media={[{kind:'image',url:'https://example.com/photo.png',alt:'Visible description',sensitive:true,warning:'Spoiler'},{kind:'audio',url:'https://example.com/audio.mp3',alt:'Interview'},{kind:'video',url:'https://example.com/video.mp4',alt:'Clip'}]}/>);`,resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"production"'}});
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sH8AAAAASUVORK5CYII=","base64");
const requests=[];let fail=true;
const server=createServer((req,res)=>{
 requests.push(req.url);
 if(req.url==="/app.js"){res.setHeader("content-type","application/javascript");res.end(result.outputFiles[0].contents);return;}
 if(req.url.startsWith("/api/feed/media")){if(fail){res.writeHead(502);res.end();return;}res.setHeader("content-type","image/png");res.end(png);return;}
 res.setHeader("content-type","text/html");res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 const external=[];page.on("request",request=>{if(!request.url().startsWith(origin))external.push(request.url());});
 await page.goto(origin);await page.getByRole("button",{name:"Show media"}).waitFor();
 assert.equal(requests.some(url=>url.includes("photo.png")),false);
 assert.equal(await page.locator("audio[controls][preload=none]").count(),1);
 assert.equal(await page.locator("video[controls][preload=none]").count(),1);
 assert.equal(await page.locator("[autoplay]").count(),0);
 await page.getByRole("button",{name:"Show media"}).click();
 await page.getByRole("button",{name:"Retry media"}).waitFor();fail=false;
 await page.getByRole("button",{name:"Retry media"}).click();
 await page.waitForFunction(()=>{const image=document.querySelector("figure img");return image?.complete && image.naturalWidth>0;});
 await page.getByRole("button",{name:"Expand image"}).click();
 assert.equal(await page.locator("dialog[open]").count(),1);
 await page.keyboard.press("Escape");assert.equal(await page.locator("dialog[open]").count(),0);
 assert.deepEqual(external,[]);console.log("Public media reveal, retry, dialog and proxy-only browser contracts passed");
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
