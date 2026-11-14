// Synthetic UI/crypto contract only. This does not qualify hosted login or storage.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "playwright-core";
if(process.env.GITHUB_ACTIONS!=="true")throw Error("Private upload browser contracts run in CI only");
const pair={pub:"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
 epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const tenant="11111111-1111-4111-8111-111111111111";
const meme=process.env.S3RCH_UPLOAD_FIXTURE==="meme";
const result=await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {PrivateMediaUpload} from './components/PrivateMediaUpload'; import {MemeEditor} from './components/MemeEditor'; import {openMediaFile} from './lib/media-file'; import {readMemePngTags} from './lib/meme-png-tags'; import {rememberUnlockedMeshPair} from './lib/identity/unlocked-mesh'; rememberUnlockedMeshPair('ci-fixture',${JSON.stringify(pair)}); window.verifyMeme=async(cipher,material,object)=>{const file=await openMediaFile(new Uint8Array(cipher),material.reference.sha256,material.wrap,${JSON.stringify(pair.epriv)},${JSON.stringify(pair.epub)},{tenant:'${tenant}',object},material.wrap);return {bytes:Array.from(file.bytes),tags:readMemePngTags(file.bytes)};}; createRoot(document.getElementById('root')).render(${meme}? (location.pathname==='/resume'?<PrivateMediaUpload tenant="${tenant}"/>:<MemeEditor tenant="${tenant}"/>):<PrivateMediaUpload tenant="${tenant}"/>);`,resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"production"'}});
let object="",allocated=false,lost=false,storedCipher=null,storedMaterial=null;const applied=new Map(),writes=[];const errors=[];
const server=createServer(async(req,res)=>{
 const json=(value,status=200)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
 try {
  if(req.url==="/app.js"){res.setHeader("content-type","text/javascript");res.end(result.outputFiles[0].contents);return;}
  if(req.url==="/"||req.url==="/resume"){res.setHeader("content-type","text/html");res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');return;}
  if(req.url==="/favicon.ico"){res.writeHead(204);res.end();return;}
  if(req.url==="/api/identity/sea/session"){json({enabled:true,principal:pair.pub,expiresAt:Date.now()+120000});return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
  const body=req.headers['content-type']==='application/json'?JSON.parse(raw):null;
  if(body){assert.ok(!raw.toString().includes(pair.priv));assert.ok(!raw.toString().includes(pair.epriv));}
  const action=req.url.split('/').at(-1);
  if(action==='catalog'){json({at:Math.floor(Date.now()/1000),objects:[],nextPage:1,principal:pair.pub});return;}
  if(action==='view'){
   if(!allocated){json({},403);return;}
   const grant=applied.get('grant');const entries=grant?[Object.fromEntries(['accessor','grantRevision','stated','from','until'].map(k=>[k,grant.claims[k]]))]:[];
   json({at:Math.floor(Date.now()/1000),fence:'a'.repeat(64),objectVersion:applied.size,owner:pair.pub,
    snapshot:{entries:entries.map(row=>({...row,scope:'direct',setId:'',hamState:0}))},bindings:{[pair.pub]:{pub:pair.pub,epub:pair.epub,head:0}}});return;
  }
  if(action==='allocate'){allocated=true;object=body.object;writes.push('allocate');json({object,accepted:true});return;}
  if(action==='upload-state'){json({at:Math.floor(Date.now()/1000),state:!applied.has(body.operation)?'absent':JSON.stringify(applied.get(body.operation))===JSON.stringify(body.payload)?'applied':'conflict'});return;}
  if(action==='mutate'){
   writes.push(body.operation);applied.set(body.operation,body.payload);
   if(body.operation==='epoch'&&!lost){lost=true;json({},503);return;}
   json({accepted:true});return;
  }
  if(action==='publish-wrap'){storedMaterial=JSON.parse(Buffer.from(body.wrapBase64,'base64').toString());writes.push('wrap');applied.set('wrap',body.metadata);json({record:body.metadata.digest,digest:body.metadata.digest});return;}
  assert.equal(decodeURIComponent(req.url),'/api/media/'+object);
  if(req.method==='POST'){writes.push('register');assert.equal(body.object,object);}
  else {assert.equal(req.method,'PUT');storedCipher=Array.from(raw);writes.push('put');assert.equal(raw.subarray(0,4).toString('hex'),'73336d01');assert.ok(!raw.includes(Buffer.from('private fixture bytes')));}
  res.writeHead(201);res.end();
 } catch(error){errors.push(String(error));if(!res.headersSent)json({},500);else res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const external=[];
 page.on('request',request=>{if(!request.url().startsWith(origin)&&!request.url().startsWith('blob:'+origin))external.push(request.url());});
 await page.goto(origin);let rendered;
 if(meme){
  await page.getByLabel('Top caption').fill('Private meme');
  await page.getByLabel('Tags (comma separated, up to 12)').fill('Team, demo');
  await page.getByRole('button',{name:'Prepare PNG'}).click();
  await page.getByRole('link',{name:'Save PNG'}).waitFor();
  rendered=await page.getByRole('link',{name:'Save PNG'}).evaluate(async link=>Array.from(new Uint8Array(await(await fetch(link.href)).arrayBuffer())));
  assert.deepEqual(writes,[]);
 }else{
  await page.getByRole('button',{name:'Upload privately'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Upload privately'}).isDisabled(),true);
  await page.locator('input[type=file]').setInputFiles({name:'private.png',mimeType:'image/png',buffer:Buffer.from('private fixture bytes')});
 }
 await page.getByRole('button',{name:'Upload privately'}).click();
 await page.getByRole('status').filter({hasText:'Upload stopped.'}).waitFor();
 assert.deepEqual(writes,['allocate','grant','epoch']);
 if(meme)await page.goto(origin+'/resume');else await page.reload();
 await page.getByRole('button',{name:'Check pending upload'}).click();
 await page.getByText('Pending: '+(meme?'s3rch-meme.png':'private.png'),{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Discard local recovery draft'}).isDisabled(),true);
 await page.getByRole('button',{name:'Resume this upload'}).click();
 await page.getByRole('status').filter({hasText:'Upload complete.'}).waitFor();
 assert.deepEqual(writes,['allocate','grant','epoch','wrap','register','put']);
 await page.getByRole('button',{name:'Check pending upload'}).click();
 await page.getByRole('status').filter({hasText:'No pending upload'}).waitFor();
 if(meme){
  const opened=await page.evaluate(async input=>window.verifyMeme(input.cipher,input.material,input.object),{cipher:storedCipher,material:storedMaterial,object});
  assert.deepEqual(opened.bytes,rendered);assert.deepEqual(opened.tags,['team','demo']);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('Synthetic private upload reload/reconciliation/UI contract passed; hosted login/storage not qualified');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
