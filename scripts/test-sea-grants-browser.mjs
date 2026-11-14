// Isolated grant UI/inbox regression; no deployed session or shared Gun peer.
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";
if (process.env.GITHUB_ACTIONS !== "true") throw Error("SEA grant browser scenarios run in CI only");
const principal = () => {
  const pair = createECDH("prime256v1"); pair.generateKeys(); const pub = pair.getPublicKey();
  return `${pub.subarray(1, 33).toString("base64url")}.${pub.subarray(33).toString("base64url")}`;
};
const owner = principal(), accessor = principal();
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PostSeeGrantControls} from './components/PostSeeGrantControls';
import {SeeAclProvider,useSeeAcl} from './components/SeeAclProvider';
import {GunPeerProvider,useGunPeer} from './components/GunPeerProvider';
import {composeNativePost,admitNativePost} from './lib/compose';
import {acceptGrantDelivery} from './lib/grant-delivery';
import {createMemorySeeAcl} from './lib/identity/see-acl';
import {checkSee,itemSoul} from './lib/identity/check';
import {itemsForTab} from './lib/feed-tabs';
const owner=${JSON.stringify(owner)}, accessor=${JSON.stringify(accessor)};
const item=composeNativePost({address:owner,body:'Private SEA grant fixture',entropy:'abcd',nowSeconds:Math.floor(Date.now()/1000)});
let lastDelivery=null; const accessorAcl=createMemorySeeAcl();
function ref(path=[]) {return {get:key=>ref([...path,key]),put:data=>{
 if(path[0]==='s3rch'&&path[1]==='granted') {lastDelivery=data;window.dispatchEvent(new Event('fixture-inbox'));}
 return ref(path);
}};}
const gun=ref();
function App(){
 const see=useSeeAcl(),peer=useGunPeer();const [ready,setReady]=useState(false),[viewer,setViewer]=useState('sea'),[rows,setRows]=useState([]);
 useEffect(()=>{peer.register(gun);return()=>peer.register(null)},[peer.register]);
 useEffect(()=>{if(see.ready){admitNativePost(see.acl,item,owner);setReady(true)}},[see.ready]);
 useEffect(()=>{function receive(){
   const principal=viewer==='wallet'?'0x'+'a'.repeat(40):accessor;
   const result=lastDelivery?acceptGrantDelivery(accessorAcl,lastDelivery,principal,Math.floor(Date.now()/1000)):null;
   if(!result||'denied' in result||'retracted' in result){setRows([]);return;}
   const allowed=checkSee(accessorAcl,itemSoul(item.id),principal,Math.floor(Date.now()/1000)).allowed;
   setRows(allowed&&'item' in result?itemsForTab('granted',[],[],[],[result.item]):[]);
 }receive();window.addEventListener('fixture-inbox',receive);return()=>window.removeEventListener('fixture-inbox',receive)},[viewer]);
 return <><h1>Isolated SEA grants</h1>{ready&&<PostSeeGrantControls address={owner} item={item}/>}
 <button onClick={()=>setViewer('sea')}>SEA login</button><button onClick={()=>setViewer('linked')}>Other linked login</button><button onClick={()=>setViewer('wallet')}>Wallet only</button>
 <section aria-label="Granted inbox">{rows.map(row=><p key={row.id}>{row.body}</p>)}</section></>;
}
createRoot(document.getElementById('root')).render(<SeeAclProvider><GunPeerProvider><App/></GunPeerProvider></SeeAclProvider>);
` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); }
  else { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>'); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(origin + "/")) external.push(request.url()); });
  await page.goto(origin);
  await page.getByPlaceholder("Recipient SEA public key").fill("0x" + "a".repeat(40));
  await page.getByRole("button", { name: "Grant see", exact: true }).click();
  await page.getByText("Enter a SEA public key.", { exact: true }).waitFor();
  await page.getByPlaceholder("Recipient SEA public key").fill(accessor);
  await page.getByRole("button", { name: "Grant see", exact: true }).click();
  const delivered = page.getByRole("region", { name: "Granted inbox" }).getByText("Private SEA grant fixture", { exact: true });
  await delivered.waitFor();
  await page.getByRole("button", { name: "Other linked login", exact: true }).click(); await delivered.waitFor();
  await page.getByRole("button", { name: "Wallet only", exact: true }).click(); await delivered.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "SEA login", exact: true }).click(); await delivered.waitFor();
  await page.getByRole("button", { name: "Revoke", exact: true }).click(); await delivered.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Other linked login", exact: true }).click();
  assert.equal(await delivered.count(), 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log("PASS sea-grant-view-revoke: SEA UI/inbox admission, linked principal continuity, wallet refusal and revoke");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
