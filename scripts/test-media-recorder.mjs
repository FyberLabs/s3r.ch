import assert from "node:assert/strict";
import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Recording browser contracts run in CI only");
const bundle=await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import {MediaRecorderDraft} from './components/MediaRecorderDraft';createRoot(document.getElementById('root')).render(<MediaRecorderDraft/>);",resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"production"'}});
const server=createServer((req,res)=>{res.setHeader("content-type",req.url==="/app.js"?"text/javascript":"text/html");res.end(req.url==="/app.js"?bundle.outputFiles[0].contents:'<!doctype html><div id="root"></div><script src="/app.js"></script>');});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true,args:["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"]});const context=await browser.newContext();const page=await context.newPage();const errors=[],remote=[];
 page.on("pageerror",error=>errors.push(error.message));await page.route("**/*",route=>{if(new URL(route.request().url()).origin!==origin){remote.push(route.request().url());return route.abort();}return route.continue();});
 await page.addInitScript(()=>{window.captured=[];const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.captured.push(stream);return stream;};});
 await page.goto(origin);assert.equal(await page.evaluate(()=>window.captured.length),0);
 for(const mode of ["audio","video"]){
  await page.getByLabel("Recording type").selectOption(mode);await page.getByRole("button",{name:`Start ${mode} recording`}).click();await page.getByRole("button",{name:"Stop recording"}).waitFor();
  await page.waitForTimeout(1200);await page.getByRole("button",{name:"Stop recording"}).click();await page.getByRole("link",{name:"Save recording"}).waitFor();
  const output=await page.getByRole("link",{name:"Save recording"}).evaluate(async link=>{const b=await(await fetch(link.href)).blob();return {size:b.size,type:b.type};});assert.ok(output.size>0);assert.equal(output.type,`${mode}/webm`);
  const player=page.getByLabel(mode==="audio"?"Recorded audio":"Recorded video");await player.evaluate(element=>element.play());await page.waitForFunction(()=>{const p=document.querySelector("audio[controls],video[controls]");return p&&p.currentTime>0.05;});await player.evaluate(element=>element.pause());
  assert.equal(await page.evaluate(()=>window.captured.flatMap(s=>s.getTracks()).every(t=>t.readyState==="ended")),true);
  await page.getByRole("button",{name:"Clear recording"}).click();assert.equal(await page.getByRole("link",{name:"Save recording"}).count(),0);
 }
 const other=await page.context().newPage();await other.goto(origin);await page.bringToFront();
 await page.getByRole("button",{name:"Start video recording"}).click();await page.getByRole("button",{name:"Stop recording"}).waitFor();
 await other.evaluate(()=>localStorage.setItem("s3rch-session-changed",crypto.randomUUID()));await page.waitForFunction(()=>window.captured.flatMap(s=>s.getTracks()).every(t=>t.readyState==="ended"));await other.close();
 await page.getByRole("button",{name:"Start video recording"}).click();await page.getByRole("button",{name:"Stop recording"}).waitFor();
 await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});document.dispatchEvent(new Event("visibilitychange"));});
 await page.getByRole("button",{name:"Start video recording"}).waitFor({state:"visible"});
 assert.equal(await page.evaluate(()=>window.captured.flatMap(s=>s.getTracks()).every(t=>t.readyState==="ended")),true);assert.equal(await page.getByRole("link",{name:"Save recording"}).count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);console.log("PASS local audio/video capture, playable output, track shutdown and hidden-tab discard");
}catch(error){if(browser){for(const context of browser.contexts())for(const page of context.pages())console.log("Recording fixture state",await page.locator("[role=status]").allTextContents(),await page.evaluate(()=>({captured:window.captured?.length,visibility:document.visibilityState,secure:isSecureContext})));}throw error;}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
