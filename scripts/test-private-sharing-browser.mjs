// Synthetic sharing UI/crypto contract only; hosted login/storage is separate.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Sharing browser contracts run in CI only");
const pair={pub:"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
 epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const owner=pair.pub,reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const tenant="11111111-1111-4111-8111-111111111111";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const context={object,epoch:1,revisionId:"b".repeat(64)};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PrivateMediaLibrary} from './components/PrivateMediaLibrary';import {sealMediaFile} from './lib/media-file';import {rememberUnlockedMeshPair,forgetUnlockedMeshPair} from './lib/identity/unlocked-mesh';const pair=${JSON.stringify(pair)};rememberUnlockedMeshPair('ci-fixture',pair);window.lockIdentity=forgetUnlockedMeshPair;window.seed=async()=>{const s=await sealMediaFile(new TextEncoder().encode('private fixture'),{name:'private.png',mediaType:'image/png'},{tenant:'${tenant}',object:'${object}'},${JSON.stringify(context)},[{account:pair.pub,pub:pair.pub,identityPub:pair.pub,epub:pair.epub}],[pair.pub]);return {...s,bytes:Array.from(s.bytes)};};createRoot(document.getElementById('root')).render(<PrivateMediaLibrary tenant="${tenant}"/>);`,resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"production"'},plugins:[{name:"synthetic-identity-display",setup(b){b.onLoad({filter:/[/\\]IdentityBar\.tsx$/},()=>({contents:"export function IdentityBar(){return null}",loader:"tsx"}));}}]});
let seed,lost=false;const applied=new Map(),writes=[],errors=[];
const bindings={[owner]:{pub:owner,epub:pair.epub,head:0},[reader]:{pub:reader,epub:reader,head:0}};
const grants=()=>[owner,reader].map(accessor=>({object,owner,accessor,from:0,until:Number.MAX_SAFE_INTEGER,stated:1,epoch:2,grantRevision:2,itemCiphertextDigest:seed.sha256}));
const snapshot=()=>({entries:grants().map(g=>({accessor:g.accessor,from:g.from,until:g.until,stated:1,grantRevision:2,scope:'direct',setId:'',hamState:0}))});
const label=(op,p)=>op==='grant'?'grant:'+p.claims.accessor:op==='wrap'?'wrap:'+p.reader:op;
const server=createServer(async(req,res)=>{
 const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
 try {
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');return;}
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);return;}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(req.url==='/api/identity/sea/session'){json({enabled:true,principal:owner,expiresAt:Date.now()+120000});return;}
  const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks),body=raw.length?JSON.parse(raw):null;
  if(body){assert.ok(!raw.toString().includes(pair.priv));assert.ok(!raw.toString().includes(pair.epriv));}
  const action=req.url.split('/').at(-1),at=Math.floor(Date.now()/1000),fence='a'.repeat(64);
  if(action==='catalog'){json({at,objects:[object],nextPage:1,principal:owner});return;}
  if(action==='view'){json({at,fence,objectVersion:1,owner,snapshot:snapshot(),bindings});return;}
  if(action==='status-view'){json({at,fence,ownerPub:owner,status:{object,epoch:applied.has('epoch')?2:1,revisionId:'b'.repeat(64),accessor:body.reader,grantRevision:2,stated:1,signedAt:at*1000,maxAgeMs:60000,zookie:{object,objectVersion:1,snapshotHash:'c'.repeat(64)}}});return;}
  if(action==='share-view'){json({at,fence,owner,ownerPub:owner,reader,previousEpoch:1,previousFinalizationId:'d'.repeat(64),grants:grants(),snapshot:snapshot(),bindings});return;}
  if(action==='read-wrap'){json({context,readerEpub:pair.epub,expiresAt:Date.now()/1000+2,wrapBase64:Buffer.from(JSON.stringify({wrap:seed.wraps[0],reference:{sha256:seed.sha256,length:seed.bytes.length}})).toString('base64')});return;}
  if(req.method==='GET'&&decodeURIComponent(req.url)==='/api/media/'+object){res.writeHead(200,{'content-type':'application/octet-stream','content-length':seed.bytes.length,etag:'"'+seed.sha256+'"'});res.end(Buffer.from(seed.bytes));return;}
  if(action==='share-state'){const held=applied.get(label(body.operation,body.payload));json({at,state:held?JSON.stringify(held)===JSON.stringify(body.payload)?'applied':'conflict':'absent'});return;}
  if(action==='mutate'&&body.operation==='status'){json({accepted:true});return;}
  const op=action==='publish-wrap'?'wrap':body.operation,p=op==='wrap'?body.metadata:body.payload;
  const k=label(op,p);writes.push(k);applied.set(k,p);
  if(op==='epoch'&&!lost){lost=true;json({},503);return;}
  json(op==='wrap'?{record:p.record,digest:p.digest}:{accepted:true});
 } catch(error){errors.push(String(error));if(!res.headersSent)json({},500);else res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}`);seed=await page.evaluate(()=>window.seed());
 await page.getByRole('button',{name:'Refresh my media',exact:true}).click();
 await page.getByRole('button',{name:'Manage sharing'}).click();await page.getByLabel('Recipient SEA account').fill(reader);
 await page.getByRole('button',{name:'Share with this identity'}).click();
 await page.getByRole('status').filter({hasText:'Sharing could not be confirmed.'}).waitFor();
 assert.equal(writes.length,3);await page.reload();
 await page.getByRole('button',{name:'Check saved sharing'}).click();await page.getByRole('button',{name:'Resume sharing'}).click();
 await page.getByRole('status').filter({hasText:'Sharing confirmed.'}).waitFor();
 assert.equal(writes.length,5);assert.equal(new Set(writes).size,5);
 await page.getByRole('button',{name:'Check saved sharing'}).click();await page.getByRole('status').filter({hasText:'No pending sharing change.'}).waitFor();
 await page.getByRole('button',{name:'Refresh my media',exact:true}).click();await page.getByRole('button',{name:'Manage sharing'}).click();
 await page.getByLabel('Recipient SEA account').fill(reader);await page.evaluate(()=>window.lockIdentity());
 assert.equal(await page.getByLabel('Recipient SEA account').count(),0);assert.deepEqual(errors,[]);
 console.log('Synthetic sharing reload/reconciliation/UI contract passed; hosted login/storage not qualified');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
