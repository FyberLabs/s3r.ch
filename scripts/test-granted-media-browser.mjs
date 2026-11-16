import {writeNightlyCaseResults} from "./nightly-case-results.mjs";
// Synthetic reader UI/crypto contract; hosted identities and storage are separate.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const names=['direct-open','unmount-cleanup','direct-revocation','direct-catalog-removal','direct-session-cleanup','group-open','group-revocation','group-catalog-removal','group-session-cleanup'];
const cases=names.map(name=>({name,status:'blocked'}));
async function runCase(name,work){const row=cases.find(row=>row.name===name);try{await work();row.status='passed';}catch{row.status='failed';throw Error('granted-media-case-failed');}}
let fixtureRoot;
async function main(){
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Granted media browser contracts run in CI only');
const pair={pub:'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',priv:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
 epub:'EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c',epriv:'6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8'};
const owner='fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E';
const object='media_p_'+owner.split('.').map(part=>Buffer.from(part,'base64url').toString('hex')).join('')+'_11111111111111111111111111111111';
const groupObject=object.slice(0,-32)+'2'.repeat(32);
const tenant='11111111-1111-4111-8111-111111111111',context={object,epoch:1,revisionId:'b'.repeat(64)};
const kind=process.env.S3RCH_GRANTED_FIXTURE??'image';
if(!['image','audio','video'].includes(kind))throw Error('Invalid fixture kind');
fixtureRoot=mkdtempSync(join(tmpdir(),'s3rch-granted-ci-'));
let bytes64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sH8AAAAASUVORK5CYII=';
const mediaType=kind==='audio'?'audio/wav':kind==='video'?'video/webm':'image/png',name='Shared '+kind;
if(kind!=='image'){
 const file=join(fixtureRoot,kind==='audio'?'audio.wav':'video.webm');
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',kind==='audio'?'sine=frequency=440:sample_rate=16000':'color=c=blue:s=64x64:r=10','-t','2',...(kind==='video'?['-c:v','libvpx','-an']:[]),file]);
 bytes64=readFileSync(file).toString('base64');
}
const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {GrantedMediaFeed} from './components/GrantedMediaFeed';import {sealMediaFile} from './lib/media-file';import {groupFixture} from './scripts/group-granted-browser-fixture';import {rememberUnlockedMeshPair} from './lib/identity/unlocked-mesh';const pair=${JSON.stringify(pair)};rememberUnlockedMeshPair('ci-reader',pair);const root=createRoot(document.getElementById('root'));window.show=()=>root.render(<React.StrictMode><GrantedMediaFeed/></React.StrictMode>);window.hide=()=>root.render(null);window.seed=async()=>{const bytes=Uint8Array.from(atob('${bytes64}'),c=>c.charCodeAt(0));const s=await sealMediaFile(bytes,{name:'${name}',mediaType:'${mediaType}',...("${kind}"==='audio'?{tags:['team','demo']}:{})},{tenant:'${tenant}',object:'${object}'},${JSON.stringify(context)},[{account:pair.pub,pub:pair.pub,identityPub:pair.pub,epub:pair.epub}],[pair.pub]);return {...s,bytes:Array.from(s.bytes)};};window.groupSeed=()=>groupFixture(Uint8Array.from(atob('${bytes64}'),c=>c.charCodeAt(0)),{name:'Group ${kind}',mediaType:'${mediaType}'},'${tenant}','${groupObject}',pair);window.show();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'}});
let seed,groupSeed,groupCatalog=false,groupAllowed=true,groupDownloads=0,allowed=true,catalog=true,downloads=0;const errors=[];
const server=createServer(async(req,res)=>{
 const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 try {
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');return;}
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(result.outputFiles[0].contents);return;}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(req.url==='/api/identity/sea/session'){json({enabled:true,principal:pair.pub,expiresAt:Date.now()+120000});return;}
  if(req.url==='/api/media/config'){json({tenant});return;}
  if(req.url==='/api/media/catalog'){json({at:Math.floor(Date.now()/1000),principal:pair.pub,objects:catalog?[object]:[],nextPage:1});return;}
  if(req.url==='/api/media/groups/item-reader-catalog'){json({at:Math.floor(Date.now()/1000),entries:groupCatalog?[groupSeed.entry]:[],nextPage:1});return;}
  if(req.url==='/api/media/groups/wrap-read'){json({...groupSeed.group,expires_at:Math.floor(Date.now()/1000)+2});return;}
  if(req.url==='/api/media/groups/item-wrap-read'){
   if(!groupAllowed){json({},403);return;}
   json({...groupSeed.item,expires_at:Math.floor(Date.now()/1000)+2});return;
  }
  if(decodeURIComponent(new URL(req.url,'http://fixture').pathname)==='/api/media/'+groupObject){
   assert.deepEqual(Object.fromEntries(new URL(req.url,'http://fixture').searchParams),{predicate:groupSeed.entry.predicate,set:groupSeed.entry.set});
   assert.equal(req.method,'GET');groupDownloads++;
   res.writeHead(200,{'content-type':'application/octet-stream','content-length':groupSeed.bytes.length,etag:'"'+groupSeed.sha256+'"'});res.end(Buffer.from(groupSeed.bytes));return;
  }
  if(req.url==='/api/media/read-wrap'){
   if(!allowed){json({},403);return;}
   json({context,readerEpub:pair.epub,expiresAt:Date.now()/1000+2,wrapBase64:Buffer.from(JSON.stringify({wrap:seed.wraps[0],reference:{sha256:seed.sha256,length:seed.bytes.length}})).toString('base64')});return;
  }
  assert.equal(decodeURIComponent(req.url),'/api/media/'+object);assert.equal(req.method,'GET');downloads++;
  res.writeHead(200,{'content-type':'application/octet-stream','content-length':seed.bytes.length,etag:'"'+seed.sha256+'"'});res.end(Buffer.from(seed.bytes));
 }catch(error){errors.push(String(error));json({},500);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.addInitScript(()=>{window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};});
 await page.goto(`http://127.0.0.1:${server.address().port}`);seed=await page.evaluate(()=>window.seed());
 const refresh=()=>page.getByRole('button',{name:'Refresh granted media'}).click();
 const open=()=>page.getByRole('button',{name:'Open shared file 1',exact:true}).click();
 await page.getByRole('button',{name:'Refresh group media',exact:true}).click();
 await page.getByText('No currently available group files on this page.',{exact:true}).waitFor();
 await runCase('direct-open',async()=>{
 await refresh();await open();await page.getByRole('heading',{name,exact:true}).waitFor();
 const url=await page.getByRole('article',{name:'Private media post'}).locator(kind==='image'?'img':kind).getAttribute('src');assert.ok(url.startsWith('blob:'));assert.equal(downloads,1);
 if(kind==='audio'){await page.getByLabel('Audio tags').waitFor();assert.equal(await page.getByLabel('Audio tags').textContent(),'#team · #demo');}
 if(kind!=='image'){
  await page.locator(kind).evaluate(async element=>{window.lastPlayer=element;await element.play();});
  await page.waitForFunction(()=>window.lastPlayer.currentTime>0.1);
 }
 });
 await runCase('unmount-cleanup',async()=>{
 await page.evaluate(()=>window.hide());await page.waitForFunction(()=>window.revoked.length===1);assert.equal(await page.getByRole('article').count(),0);
 if(kind!=='image')assert.equal(await page.evaluate(()=>window.lastPlayer.paused&&!window.lastPlayer.hasAttribute('src')),true);
 });
 await runCase('direct-revocation',async()=>{
 await page.evaluate(()=>window.show());await refresh();allowed=false;await open();
 await page.getByRole('status').filter({hasText:'Media is unavailable.'}).waitFor();assert.equal(downloads,1);assert.equal(await page.getByRole('article').count(),0);
 });
 await runCase('direct-catalog-removal',async()=>{
 catalog=false;await refresh();await page.getByText('No currently available shared files on this page.').waitFor();
 });
 await runCase('direct-session-cleanup',async()=>{
 allowed=true;catalog=true;await refresh();await open();await page.getByRole('article').waitFor();
 await page.evaluate(()=>window.dispatchEvent(new Event('s3rch-session-changed')));
 await page.waitForFunction(()=>window.revoked.length===2);assert.equal(await page.getByRole('article').count(),0);
 });
 groupSeed=await page.evaluate(()=>window.groupSeed());groupCatalog=true;
 const groupRefresh=()=>page.getByRole('button',{name:'Refresh group media',exact:true}).click();
 const groupOpen=()=>page.getByRole('button',{name:'Open group file 1',exact:true}).click();
 await runCase('group-open',async()=>{
 await groupRefresh();await groupOpen();await page.getByRole('heading',{name:'Group '+kind,exact:true}).waitFor();
 assert.equal(groupDownloads,1);assert.ok((await page.getByRole('article',{name:'Private media post'}).locator(kind==='image'?'img':kind).getAttribute('src')).startsWith('blob:'));
 });
 await runCase('group-revocation',async()=>{
 groupAllowed=false;await groupRefresh();await groupOpen();
 await page.getByRole('status').filter({hasText:'Media is unavailable.'}).waitFor();assert.equal(groupDownloads,1);assert.equal(await page.getByRole('article').count(),0);
 });
 await runCase('group-catalog-removal',async()=>{
 groupCatalog=false;await groupRefresh();await page.getByText('No currently available group files on this page.',{exact:true}).waitFor();
 });
 await runCase('group-session-cleanup',async()=>{
 groupAllowed=true;groupCatalog=true;await groupRefresh();await groupOpen();await page.getByRole('heading',{name:'Group '+kind,exact:true}).waitFor();
 const before=await page.evaluate(()=>window.revoked.length);await page.evaluate(()=>window.dispatchEvent(new Event('s3rch-session-changed')));
 await page.waitForFunction(count=>window.revoked.length===count+1,before);assert.equal(await page.getByRole('article').count(),0);
 });
 assert.deepEqual(errors,[]);console.log('Granted media UI, denied open, session reset and unmount cleanup contracts passed; hosted services not qualified');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(fixtureRoot,{recursive:true,force:true});}

}
await main().catch(()=>{process.exitCode=1;}).finally(()=>{
 if(fixtureRoot)rmSync(fixtureRoot,{recursive:true,force:true});
 const requested=process.env.S3RCH_GRANTED_FIXTURE??'image',kind=['image','audio','video'].includes(requested)?requested:'invalid';
 const report=writeNightlyCaseResults({suite:'granted-media-'+kind,expectedCases:names,cases});
 console.log(JSON.stringify(report));if(report.status!=='passed')process.exitCode=1;
});
