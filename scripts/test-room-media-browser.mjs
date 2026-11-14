// Synthetic reader UI/crypto contract; hosted identities and storage are separate.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Room media browser contracts run in CI only');
const pair={pub:'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',priv:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
 epub:'EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c',epriv:'6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8'};
const owner=pair.pub;
const object='media_p_'+owner.split('.').map(part=>Buffer.from(part,'base64url').toString('hex')).join('')+'_11111111111111111111111111111111';
const tenant='11111111-1111-4111-8111-111111111111',context={object,epoch:1,revisionId:'b'.repeat(64)};
const kind=process.env.S3RCH_ROOM_MEDIA_FIXTURE??'audio';
if(!['audio','video'].includes(kind))throw Error('Invalid fixture kind');
const fixtureRoot=mkdtempSync(join(tmpdir(),'s3rch-granted-ci-'));
let bytes64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sH8AAAAASUVORK5CYII=';
const mediaType=kind==='audio'?'audio/wav':kind==='video'?'video/webm':'image/png',name='Shared '+kind;
if(kind!=='image'){
 const file=join(fixtureRoot,kind==='audio'?'audio.wav':'video.webm');
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',kind==='audio'?'sine=frequency=440:sample_rate=16000':'color=c=blue:s=64x64:r=10','-t','2',...(kind==='video'?['-c:v','libvpx','-an']:[]),file]);
 bytes64=readFileSync(file).toString('base64');
}
const result=await build({stdin:{contents:`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RoomMediaPanel} from './components/RoomMediaPanel';
import {composeRoomMedia} from './lib/room-media';
import {sealMediaFile} from './lib/media-file';
import {rememberUnlockedMeshPair} from './lib/identity/unlocked-mesh';
void (async()=>{
 const {pair,owner,object,tenant,context,bytes64,name,mediaType}=await (await fetch('/fixture.json')).json();
 rememberUnlockedMeshPair('ci-reader',pair);
 const root=createRoot(document.getElementById('root'));
 window.roomAllowed=true;window.sent=[];window.deferSend=false;
 const message={id:'admitted-fixture-row',room:'ci-room',author:owner,body:composeRoomMedia(object),ts:1};
 window.show=()=>root.render(<React.StrictMode><RoomMediaPanel tenant={tenant} roomId='ci-room'
   messages={[message,{...message,id:'unadmitted-row'}]} canRead={row=>window.roomAllowed&&row.id==='admitted-fixture-row'}
   send={async(body,current)=>{if(window.deferSend)await new Promise(resolve=>{window.releaseSend=resolve;});if(!current())return false;window.sent.push(body);return true;}}/>
 </React.StrictMode>);
 window.hide=()=>root.render(null);
 window.seed=async()=>{const bytes=Uint8Array.from(atob(bytes64),c=>c.charCodeAt(0));
   const sealed=await sealMediaFile(bytes,{name,mediaType},{tenant,object},context,
     [{account:pair.pub,pub:pair.pub,identityPub:pair.pub,epub:pair.epub}],[pair.pub]);
   return {...sealed,bytes:Array.from(sealed.bytes)};};
 window.show();
})();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'}});

let seed,allowed=true,catalog=true,downloads=0;const errors=[];
const server=createServer(async(req,res)=>{
 const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 try {
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');return;}
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(result.outputFiles[0].contents);return;}
  if(req.url==='/fixture.json'){json({pair,owner,object,tenant,context,bytes64,name,mediaType});return;}
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(req.url==='/api/identity/sea/session'){json({enabled:true,principal:pair.pub,expiresAt:Date.now()+120000});return;}
  if(req.url==='/api/media/config'){json({tenant});return;}
  if(req.url==='/api/media/catalog'){json({at:Math.floor(Date.now()/1000),principal:pair.pub,objects:catalog?[object]:[],nextPage:1});return;}
  if(req.url==='/api/media/owner/catalog'){json({at:Math.floor(Date.now()/1000),principal:pair.pub,objects:[object],nextPage:1});return;}
  if(req.url==='/api/media/owner/status-view'){
   const at=Math.floor(Date.now()/1000);json({at,fence:'a'.repeat(64),ownerPub:owner,status:{...context,accessor:pair.pub,grantRevision:1,stated:1,signedAt:at*1000,maxAgeMs:60000,zookie:{object,objectVersion:3,snapshotHash:'c'.repeat(64)}}});return;
  }
  if(req.url==='/api/media/owner/mutate'){json({accepted:true});return;}
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
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>typeof window.seed==='function');seed=await page.evaluate(()=>window.seed());
 // Room admission is explicitly substituted above; signatures have separate real-SEA unit coverage.
 const refresh=async()=>{};
 const open=()=>page.getByRole('button',{name:'Open room file 1',exact:true}).click();
 await refresh();await open();await page.getByRole('heading',{name,exact:true}).waitFor();
 const url=await page.getByRole('article',{name:'Private media post'}).locator(kind==='image'?'img':kind).getAttribute('src');assert.ok(url.startsWith('blob:'));assert.equal(downloads,1);
 if(kind!=='image'){
  await page.locator(kind).evaluate(async element=>{window.lastPlayer=element;await element.play();});
  await page.waitForFunction(()=>window.lastPlayer.currentTime>0.1);
 }
 await page.evaluate(()=>window.hide());await page.waitForFunction(()=>window.revoked.length===1);assert.equal(await page.getByRole('article').count(),0);
 if(kind!=='image')assert.equal(await page.evaluate(()=>window.lastPlayer.paused&&!window.lastPlayer.hasAttribute('src')),true);
 await page.evaluate(()=>window.show());await refresh();allowed=false;await open();
 await page.getByRole('status').filter({hasText:'Media is unavailable.'}).waitFor();assert.equal(downloads,1);assert.equal(await page.getByRole('article').count(),0);
 assert.equal(await page.getByRole('button',{name:/Open room file/}).count(),1);
 allowed=true;catalog=true;await refresh();await open();await page.getByRole('article').waitFor();
 await page.evaluate(()=>window.dispatchEvent(new Event('s3rch-session-changed')));
 await page.waitForFunction(()=>window.revoked.length===2);assert.equal(await page.getByRole('article').count(),0);
 allowed=true;await open();await page.getByRole('article').waitFor();
 await page.evaluate(()=>{window.roomAllowed=false;window.show();});
 assert.equal(await page.getByRole('button',{name:/Open room file/}).count(),0);assert.equal(await page.getByRole('article').count(),1);
 // Already decrypted playback belongs to the independent media session. Room polls do not release more bytes.
 await page.getByRole('button',{name:'Close room preview'}).click();await page.waitForFunction(()=>window.revoked.length===3);assert.equal(await page.getByRole('article').count(),0);
 // Owner status endpoint is synthetic; actual browser signing/decryption is exercised.
 await page.evaluate(()=>{window.roomAllowed=true;window.show();});
 await page.getByRole('button',{name:'Choose my audio or video'}).click();
 await page.getByRole('button',{name:'Select my file 1',exact:true}).click();
 await page.getByRole('heading',{name,exact:true}).waitFor();
 await page.getByRole('button',{name:'Send file reference',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Reference sent.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.sent),['s3rch-media:v1:'+JSON.stringify([object])]);
 await page.evaluate(()=>{window.deferSend=true;});await page.getByRole('button',{name:'Send file reference',exact:true}).click();
 await page.waitForFunction(()=>!!window.releaseSend);await page.evaluate(()=>window.hide());
 await page.waitForFunction(()=>window.revoked.length===4);await page.evaluate(()=>window.releaseSend());
 assert.equal(await page.evaluate(()=>window.sent.length),1);
 assert.deepEqual(errors,[]);console.log('Room media playback, denied open, room revocation, session reset and unmount cleanup contracts passed; hosted services not qualified');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(fixtureRoot,{recursive:true,force:true});}
