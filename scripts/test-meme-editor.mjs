import assert from "node:assert/strict";
import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Image editor browser contracts run in CI only");
const bundle=await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import {MemeEditor} from './components/MemeEditor';createRoot(document.getElementById('root')).render(<MemeEditor/>);",resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"production"'}});
const server=createServer((req,res)=>{res.setHeader("content-type",req.url==="/app.js"?"text/javascript":"text/html");res.end(req.url==="/app.js"?bundle.outputFiles[0].contents:'<!doctype html><div id="root"></div><script src="/app.js"></script>');});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();const errors=[],remote=[];
 page.on("pageerror",e=>errors.push(e.message));await page.route("**/*",route=>{if(new URL(route.request().url()).origin!==origin){remote.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin);await page.getByLabel("Top caption").fill("A <caption>");await page.getByLabel("Bottom caption").fill("Local only");
 await page.getByLabel("Layout").selectOption("panel");await page.getByRole("button",{name:"Prepare PNG"}).click();await page.getByRole("link",{name:"Save PNG"}).waitFor();
 const result=await page.getByRole("link",{name:"Save PNG"}).evaluate(async link=>{const blob=await(await fetch(link.href)).blob();const bitmap=await createImageBitmap(blob);const value={type:blob.type,width:bitmap.width,height:bitmap.height};bitmap.close();return value;});
 assert.deepEqual(result,{type:"image/png",width:1280,height:972});
 await page.getByLabel("Top caption").fill("Changed");assert.equal(await page.getByRole("link",{name:"Save PNG"}).count(),0);
 await page.locator('input[type=file]').setInputFiles({name:"empty.png",mimeType:"image/png",buffer:Buffer.alloc(0)});await page.getByRole("status").filter({hasText:"up to 8 MiB"}).waitFor();
 await page.locator('input[type=file]').setInputFiles({name:"large.png",mimeType:"image/png",buffer:Buffer.alloc(8*1024*1024+1)});await page.getByRole("status").filter({hasText:"up to 8 MiB"}).waitFor();
 const png=await page.evaluate(()=>{const c=document.createElement("canvas");c.width=300;c.height=200;c.getContext("2d").fillRect(0,0,300,200);return c.toDataURL().split(",")[1];});
 await page.locator('input[type=file]').setInputFiles({name:"source.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
 await page.waitForFunction(()=>document.querySelector("canvas").width===300);
 await page.locator('input[type=file]').setInputFiles({name:"bad.svg",mimeType:"image/svg+xml",buffer:Buffer.from('<svg/>')});
 await page.getByRole("status").filter({hasText:"Choose a PNG or JPEG"}).waitFor();
 // Clear while decode is pending: the late bitmap must be closed, not installed.
 await page.evaluate(()=>{const original=window.createImageBitmap;window.createImageBitmap=async(...args)=>{const image=await original(...args);await new Promise(resolve=>window.finishDecode=resolve);return image;};});
 await page.locator('input[type=file]').setInputFiles({name:"source.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
 await page.waitForFunction(()=>typeof window.finishDecode==="function");await page.getByRole("button",{name:"Clear draft"}).click();await page.evaluate(()=>window.finishDecode());
 await page.waitForFunction(()=>document.querySelector("canvas").width===1280);assert.equal(await page.getByLabel("Top caption").inputValue(),"");
 await page.getByLabel("Top caption").fill("Identity private draft");await page.evaluate(()=>window.dispatchEvent(new Event("s3rch-session-changed")));await page.waitForFunction(()=>document.querySelector('input[maxlength]').value==="");
 await page.getByLabel("Top caption").fill("Cross-tab private draft");await page.getByRole("button",{name:"Prepare PNG"}).click();await page.getByRole("link",{name:"Save PNG"}).waitFor();
 const other=await page.context().newPage();await other.goto(origin);await other.evaluate(()=>localStorage.setItem("s3rch-session-changed",crypto.randomUUID()));await page.waitForFunction(()=>document.querySelector('input[maxlength]').value==="");assert.equal(await page.getByRole("link",{name:"Save PNG"}).count(),0);await other.close();
 await page.getByLabel("Top caption").fill("Page departure draft");await page.evaluate(()=>window.dispatchEvent(new Event("pagehide")));await page.waitForFunction(()=>document.querySelector('input[maxlength]').value==="");
 assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);console.log("PASS image draft templates, PNG export, invalid input, stale decode and identity clearing");
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
