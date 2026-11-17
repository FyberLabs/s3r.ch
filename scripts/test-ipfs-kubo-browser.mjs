// CI-only real Chromium -> distinct HTTPS origin. Provider is a Kubo protocol substitute.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('CI only');
const directory=await mkdtemp(join(tmpdir(),'s3rch-kubo-'));
let browser,app,provider;
try {
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key'),'-out',join(directory,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const tls={key:await readFile(join(directory,'key')),cert:await readFile(join(directory,'cert'))};
 const bundle=await build({stdin:{contents:`
 import {createKuboBlockClient} from './lib/ipfs-kubo-client';
 import {rawMediaBlockCid,describeMediaBlocks} from './lib/ipfs-media-blocks';
 import {sealMedia} from './lib/media-crypto';
 import {createIpfsMediaTransfer} from './lib/ipfs-media-transfer';
 import {createCachedMediaBlocks} from './lib/ipfs-cached-blocks';
 import {createLocalCiphertextCache} from './lib/ipfs-local-cache';
 import {createSharedTransferBudget} from './lib/ipfs-transfer-budget';
 import {createSharedTransferConcurrency} from './lib/ipfs-transfer-concurrency';
 let sample,controller,pending,calls=0,resumable,resumeMedia,resumeInput,resumeGrant,preparedDownload;
 const transport=(url,init)=>{calls++;return fetch(url,init);};
 window.fetchCalls=()=>calls;
 window.exercise=async endpoint=>{
  let allowed=true;const abort=new AbortController();
  const client=createKuboBlockClient({endpoint,maxBytes:1024,current:()=>allowed,signal:abort.signal},transport);
  const sealed=await sealMedia(new Uint8Array([7,8,9]),{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'12'.repeat(32)});
  const cid=await client.put(sealed.bytes);sample={cid,bytes:sealed.bytes};const result=await client.get(cid,sealed.bytes.length);
  allowed=false;let refused=false;try{await client.get(cid,result.length);}catch{refused=true;}
  return {cid,expected:await rawMediaBlockCid(sealed.bytes),same:Array.from(result).join()===Array.from(sealed.bytes).join(),refused};
 };
 let admissionClient,admissionAuthority=true;
 window.admissionRefusals=async endpoint=>{
  const current=()=>admissionAuthority,signal=new AbortController().signal;
  admissionClient=createKuboBlockClient({endpoint,maxBytes:sample.bytes.length,maxBytesPerMinute:sample.bytes.length,current,signal},transport);
  const media=createIpfsMediaTransfer({blocks:admissionClient,current,signal});
  const binding={tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'34'.repeat(32)};
  const sealed=await sealMedia(new Uint8Array([1,2,3]),binding),manifest=JSON.stringify(await describeMediaBlocks(sealed.bytes));
  const refused=async work=>{try{const result=await work();result?.dispose?.();return false;}catch{return true;}};
  const consent=[],bindings=[],cids=[];
  try{
   for(const value of [false,undefined,null,1,'true',{},new Boolean(false),Promise.resolve(false)]){
    admissionAuthority=value;
    consent.push(await refused(()=>admissionClient.get(sample.cid,sample.bytes.length)));
    consent.push(await refused(()=>media.upload(new Uint8Array([1]),binding)));
    consent.push(await refused(()=>media.prepareUpload(new Uint8Array([1]),binding)));
    consent.push(await refused(()=>media.prepareDownload(manifest,sealed.key,binding)));
   }
   admissionAuthority=true;
   for(const binding of [null,{}, {tenant:'bad',object:'claim_'+'34'.repeat(32)}]){
    bindings.push(await refused(()=>media.download(manifest,sealed.key,binding)));
    bindings.push(await refused(()=>media.prepareDownload(manifest,sealed.key,binding)));
   }
   for(const cid of [sample.cid.slice(0,-1)+'b','bafkreiz'+sample.cid.slice(7)])
    cids.push(await refused(()=>admissionClient.get(cid,sample.bytes.length)));
   return {consent,bindings,cids};
  }finally{sealed.key.fill(0);sealed.bytes.fill(0);admissionAuthority=true;}
 };
 window.validAfterRefusals=async()=>{
  const bytes=await admissionClient.get(sample.cid,sample.bytes.length);
  return bytes.length===sample.bytes.length&&bytes.every((byte,index)=>byte===sample.bytes[index]);
 };
 window.failure=async(endpoint,upload=false,rate=1024)=>{
  const client=createKuboBlockClient({endpoint,maxBytes:1024,maxBytesPerMinute:rate,current:()=>true,signal:new AbortController().signal},transport);
  try {if(upload)await client.put(sample.bytes);else await client.get(sample.cid,sample.bytes.length);return false;}catch{return true;}
 };
 window.beginUpload=endpoint=>{
  controller=new AbortController();
  const client=createKuboBlockClient({endpoint,maxBytes:1024,current:()=>true,signal:controller.signal},transport);
  pending=client.put(sample.bytes).then(()=>false,()=>true);
 };
 window.cancelUpload=async()=>{controller.abort();return pending;};
 window.prepareResume=async endpoint=>{
  const signal=new AbortController().signal,current=()=>true;
  const blocks=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,maxBytesPerMinute:8*1024*1024,current,signal},transport);
  resumeMedia=createIpfsMediaTransfer({blocks,current,signal});resumeInput=new Uint8Array(1024*1024+7).fill(51);
  resumable=await resumeMedia.prepareUpload(resumeInput,{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'78'.repeat(32)});
 };
 window.resumeStatus=()=>resumable.status();
 window.resumeMedia=async()=>{
  try{
   const grant=await resumable.resume();resumeGrant=grant;
   const output=await resumeMedia.download(grant.manifest,grant.key,{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'78'.repeat(32)});
   return output.length===resumeInput.length&&output.every((byte,index)=>byte===resumeInput[index]);
  }catch{return false;}
 };
 window.prepareDownloadRecovery=async endpoint=>{
  const signal=new AbortController().signal,current=()=>true;
  const blocks=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,maxBytesPerMinute:8*1024*1024,current,signal},transport);
  const media=createIpfsMediaTransfer({blocks,current,signal});
  preparedDownload=await media.prepareDownload(resumeGrant.manifest,resumeGrant.key,{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'78'.repeat(32)});
 };
 window.downloadStatus=()=>preparedDownload.status();
 window.resumeDownload=async()=>{
  try{const output=await preparedDownload.resume();return output.length===resumeInput.length&&output.every((byte,index)=>byte===resumeInput[index]);}catch{return false;}
 };
 let localCache,cachedMedia,offlineMedia,cacheAllowed=true,cacheNow=1000;
 window.configureCache=endpoint=>{
  const signal=new AbortController().signal,current=()=>cacheAllowed;
  localCache=createLocalCiphertextCache({scope:'c'.repeat(64),policy:{enabled:true,maxBytes:3*1024*1024,maxEntries:4,ttlMs:1000},current,now:()=>cacheNow});
  const provider=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,maxBytesPerMinute:8*1024*1024,current,signal},transport);
  cachedMedia=createIpfsMediaTransfer({blocks:createCachedMediaBlocks({provider,cache:localCache,current,signal}),current,signal});
  offlineMedia=createIpfsMediaTransfer({blocks:createCachedMediaBlocks({provider,cache:localCache,current,signal,readPolicy:"cache-only"}),current,signal});
 };
 window.cachedRead=async(cacheOnly=false)=>{try{
  const output=await (cacheOnly?offlineMedia:cachedMedia).download(resumeGrant.manifest,resumeGrant.key,{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'78'.repeat(32)});
  return output.length===resumeInput.length&&output.every((byte,index)=>byte===resumeInput[index]);
 }catch{return false;}};
 window.cacheConsent=value=>{cacheAllowed=value;};window.cacheTime=value=>{cacheNow=value;};
 window.clearCache=async()=>{localCache.close();await localCache.clear();};
 let budgetNow=1000;
 window.budgetTime=value=>{budgetNow=value;};
 window.budgetSample=()=>({cid:JSON.parse(resumeGrant.manifest).blocks[0],size:1024*1024});
 window.sharedRead=async({endpoint,cid,size})=>{
  const current=()=>true,signal=new AbortController().signal;
  const sharedBudget=createSharedTransferBudget({maxBytesPerMinute:size,current,now:()=>budgetNow});
  const client=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,current,signal,sharedBudget},transport);
  try{return (await client.get(cid,size)).length===size;}catch{return false;}finally{sharedBudget.close();}
 };
 let slotAbort,slotPending,heldSlotAbort,heldSlotPending;
 window.slotRead=async({endpoint,cid,size})=>{
  const current=()=>true,abort=new AbortController();slotAbort=abort;
  const sharedConcurrency=createSharedTransferConcurrency({current});
  const client=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,current,signal:abort.signal,sharedConcurrency},transport);
  slotPending=client.get(cid,size).then(bytes=>bytes.length===size,()=>false);
  return slotPending;
 };
 window.beginSlot=args=>{void window.slotRead(args);heldSlotAbort=slotAbort;heldSlotPending=slotPending;};
 window.cancelSlot=async()=>{heldSlotAbort.abort();return heldSlotPending;};
 let producerCache,producerMedia,producerGrant,producerInput;
 const producerBinding={tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'9a'.repeat(32)};
 window.uploadRetained=async endpoint=>{
  const signal=new AbortController().signal,current=()=>true;
  producerCache=createLocalCiphertextCache({scope:'d'.repeat(64),policy:{enabled:true,maxBytes:3*1024*1024,maxEntries:4,ttlMs:60000},current});
  const provider=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,maxBytesPerMinute:8*1024*1024,current,signal},transport);
  producerMedia=createIpfsMediaTransfer({blocks:createCachedMediaBlocks({provider,cache:producerCache,readPolicy:'cache-only',current,signal}),current,signal});
  producerInput=new Uint8Array(1024*1024+7).fill(61);producerGrant=await producerMedia.upload(producerInput,producerBinding);
 };
 window.readRetained=async()=>{try{
  const output=await producerMedia.download(producerGrant.manifest,producerGrant.key,producerBinding);
  return output.length===producerInput.length&&output.every((value,index)=>value===producerInput[index]);
 }catch{return false;}};
 window.clearRetained=async()=>{producerCache.close();await producerCache.clear();};
 window.composed=async endpoint=>{
  const signal=new AbortController().signal,current=()=>true;
  const blocks=createKuboBlockClient({endpoint,maxBytes:8*1024*1024,maxBytesPerMinute:8*1024*1024,current,signal},transport);
  const media=createIpfsMediaTransfer({blocks,current,signal});
  const binding={tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'56'.repeat(32)};
  const input=new Uint8Array(1024*1024+7).fill(43),grant=await media.upload(input,binding);
  const output=await media.download(grant.manifest,grant.key,binding);
  return {same:output.length===input.length&&output.every((byte,index)=>byte===input[index]),blocks:JSON.parse(grant.manifest).blocks.length};
 };
 `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'browser',format:'iife'});
 const appRequests=[],providerRequests=[],errors=[];const blocks=new Map();let appOrigin,stored,mode="normal",noticed,closed,resumePuts=0;const resumeCids=[],downloadCids=[];
 app=createServer(tls,(req,res)=>{appRequests.push(req.url);res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<!doctype html><link rel="icon" href="data:,"><script src="/app.js"></script>');});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));appOrigin=`https://127.0.0.1:${app.address().port}`;
 provider=createServer(tls,async(req,res)=>{
  try {
   providerRequests.push(req.url);assert.equal(req.method,'POST');assert.equal(req.headers.origin,appOrigin);assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.referer,undefined);
   res.setHeader('Access-Control-Allow-Origin',appOrigin);
   const url=new URL(req.url,'https://fixture.invalid');
   if(mode==='resume-get-second'&&url.pathname==='/api/v0/block/get'){
    downloadCids.push(url.searchParams.get('arg'));
    if(downloadCids.length===2){res.writeHead(503);res.end();return;}
    if(downloadCids.length===3)mode='normal';
   }
   if(mode==='unavailable'){res.writeHead(503);res.end();return;}
   if(mode==='drop-upload'){req.destroy();return;}
   if(mode==='hold-upload'||mode==='hold-slot'){
    req.resume();res.once('close',()=>closed?.());noticed?.();return;
   }
   if(url.pathname==='/api/v0/block/put'){
    assert.equal(url.searchParams.get('pin'),'false');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const form=await new Request('https://fixture.invalid',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();
    stored=Buffer.from(await form.get('file').arrayBuffer());
    // CID calculation uses the same public raw codec, executed by the browser separately.
    const {createHash}=await import('node:crypto');const raw=Buffer.concat([Buffer.from([1,0x55,0x12,32]),createHash('sha256').update(stored).digest()]);
    let bits=0,value=0,cid='b';for(const byte of raw){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;cid+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];}value&=(1<<bits)-1;}if(bits)cid+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];
    if(mode==='resume-second'){
     resumeCids.push(cid);resumePuts++;
     if(resumePuts===2){res.writeHead(503);res.end();return;}
     if(resumePuts===3)mode='normal';
    }
    blocks.set(cid,stored);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Key:cid,Size:stored.length}));
   }else{assert.equal(url.pathname,'/api/v0/block/get');const selected=blocks.get(url.searchParams.get('arg'));assert.ok(selected);const body=Buffer.from(selected);if(mode==='tamper')body[body.length-1]^=1;res.end(mode==='truncate'?body.subarray(0,body.length-1):body);}
  }catch(error){errors.push(String(error));res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerOrigin=`https://127.0.0.1:${provider.address().port}`;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const unexpected=[];await context.route('**/*',async route=>{const origin=new URL(route.request().url()).origin;if(origin===appOrigin||origin===providerOrigin)return route.continue();unexpected.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(appOrigin);await page.waitForFunction(()=>!!window.exercise);
 const result=await page.evaluate(endpoint=>window.exercise(endpoint),providerOrigin);
 assert.equal(result.cid,result.expected);assert.equal(result.same,true);assert.equal(result.refused,true);
 assert.equal(providerRequests.length,2);
 const composed=await page.evaluate(endpoint=>window.composed(endpoint),providerOrigin);
 assert.deepEqual(composed,{same:true,blocks:2});assert.equal(providerRequests.length,6);
 // Admission exhaustion must cause zero provider traffic.
 assert.equal(await page.evaluate(endpoint=>window.failure(endpoint,false,1),providerOrigin),true);
 assert.equal(providerRequests.length,6);
 let networkRetries=0;
 for(const fault of ['tamper','truncate','unavailable','drop-upload']){
  mode=fault;const before=providerRequests.length,fetchBefore=await page.evaluate(()=>window.fetchCalls());
  assert.equal(await page.evaluate(({endpoint,upload})=>window.failure(endpoint,upload),{endpoint:providerOrigin,upload:fault==='drop-upload'}),true,fault);
  assert.equal(await page.evaluate(()=>window.fetchCalls()),fetchBefore+1,'one application attempt on '+fault);
  const received=providerRequests.length-before;
  if(fault==='drop-upload'){
   // Chromium may retry a connection failure internally, below the fetch API.
   assert.ok(received>=1&&received<=2,'bounded observed Chromium connection retries');networkRetries=received-1;
  }else assert.equal(received,1,'one provider request on '+fault);
 }
 async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture deadline')),5000);})]);}finally{clearTimeout(timer);}}
 // Explicit resume reuses the failed ciphertext, without resending the first block.
 mode='resume-second';const beforeResume=providerRequests.length;
 await page.evaluate(endpoint=>window.prepareResume(endpoint),providerOrigin);assert.equal(providerRequests.length,beforeResume);
 assert.equal(await page.evaluate(()=>window.resumeMedia()),false);
 assert.deepEqual(await page.evaluate(()=>window.resumeStatus()),{state:'unavailable',acknowledgedBlocks:1,totalBlocks:2});
 assert.equal(await page.evaluate(()=>window.resumeMedia()),true);
 assert.equal(providerRequests.length,beforeResume+5);assert.equal(resumeCids.length,3);assert.equal(resumeCids[1],resumeCids[2]);assert.notEqual(resumeCids[0],resumeCids[1]);
 // Retain only the verified first block; explicit download resume fetches the failed second block.
 mode='resume-get-second';const beforeDownload=providerRequests.length;
 await page.evaluate(endpoint=>window.prepareDownloadRecovery(endpoint),providerOrigin);assert.equal(providerRequests.length,beforeDownload);
 assert.equal(await page.evaluate(()=>window.resumeDownload()),false);
 assert.deepEqual(await page.evaluate(()=>window.downloadStatus()),{state:'unavailable',verifiedBlocks:1,totalBlocks:2});
 assert.equal(await page.evaluate(()=>window.resumeDownload()),true);
 assert.equal(providerRequests.length,beforeDownload+3);assert.equal(downloadCids.length,3);assert.equal(downloadCids[1],downloadCids[2]);assert.notEqual(downloadCids[0],downloadCids[1]);
 // Real IndexedDB reuse: offline reads send no provider request; revocation/expiry refuse reuse.
 mode='normal';const beforeCache=providerRequests.length;
 await page.evaluate(endpoint=>window.configureCache(endpoint),providerOrigin);
 assert.equal(await page.evaluate(()=>window.cachedRead()),true);assert.equal(providerRequests.length,beforeCache+2);
 mode='unavailable';assert.equal(await page.evaluate(()=>window.cachedRead(true)),true);assert.equal(await page.evaluate(()=>window.cachedRead()),true);assert.equal(providerRequests.length,beforeCache+2);
 await page.evaluate(()=>window.cacheConsent(false));assert.equal(await page.evaluate(()=>window.cachedRead()),false);assert.equal(providerRequests.length,beforeCache+2);
 await page.evaluate(()=>{window.cacheConsent(true);window.cacheTime(2000);});
 assert.equal(await page.evaluate(()=>window.cachedRead(true)),false);assert.equal(providerRequests.length,beforeCache+2,'cache-only expiry must not contact provider');
 assert.equal(await page.evaluate(()=>window.cachedRead()),false);assert.equal(providerRequests.length,beforeCache+3);
 await page.evaluate(()=>window.clearCache());
 // Actual separate tabs race one persistent payload allowance before dispatch.
 mode='normal';const beforeBudget=providerRequests.length;
 const other=await context.newPage();other.on('pageerror',error=>errors.push(error.message));await other.goto(appOrigin);await other.waitForFunction(()=>!!window.sharedRead);
 const budgetArgs={endpoint:providerOrigin,...await page.evaluate(()=>window.budgetSample())};
 const admissions=await Promise.all([page,other].map(tab=>tab.evaluate(args=>window.sharedRead(args),budgetArgs)));
 assert.equal(admissions.filter(Boolean).length,1);assert.equal(providerRequests.length,beforeBudget+1);
 await other.reload();await other.waitForFunction(()=>!!window.sharedRead);
 assert.equal(await other.evaluate(args=>window.sharedRead(args),budgetArgs),false);assert.equal(providerRequests.length,beforeBudget+1);
 await other.evaluate(()=>window.budgetTime(61000));assert.equal(await other.evaluate(args=>window.sharedRead(args),budgetArgs),true);assert.equal(providerRequests.length,beforeBudget+2);
 assert.equal(await page.evaluate(args=>window.sharedRead(args),budgetArgs),false,'persisted watermark refuses older tab clock');assert.equal(providerRequests.length,beforeBudget+2);
 // Two actual tabs hold two shared operation slots. Excess work does not reach the provider.
 const beforeSlots=providerRequests.length;mode='hold-slot';
 let slotSeen=new Promise(resolve=>{noticed=resolve;});
 await page.evaluate(args=>window.beginSlot(args),budgetArgs);await bounded(slotSeen);
 slotSeen=new Promise(resolve=>{noticed=resolve;});
 await other.evaluate(args=>window.beginSlot(args),budgetArgs);await bounded(slotSeen);
 assert.equal(await page.evaluate(args=>window.slotRead(args),budgetArgs),false);
 assert.equal(providerRequests.length,beforeSlots+2);
 // Closing a tab releases its browser-managed slot; no persisted lease/clock is involved.
 await other.close();
 async function waitSlotCount(expected) {
  // Playwright's waitForFunction treats a Promise as truthy; await each query explicitly.
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
   const count=await page.evaluate(async()=> (await navigator.locks.query()).held.filter(lock=>lock.name.startsWith('s3rch-ipfs-transfer-slot-v1-')).length);
   if(count===expected)return;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('shared slot release deadline');
 }
 await waitSlotCount(1);
 mode='normal';assert.equal(await page.evaluate(args=>window.slotRead(args),budgetArgs),true);
 assert.equal(providerRequests.length,beforeSlots+3);
 assert.equal(await page.evaluate(()=>window.cancelSlot()),false);
 await waitSlotCount(0);

 // Producer retention permits immediate verified playback without downloading its own upload.
 mode='normal';const beforeRetained=providerRequests.length;
 await page.evaluate(endpoint=>window.uploadRetained(endpoint),providerOrigin);assert.equal(providerRequests.length,beforeRetained+2);
 mode='unavailable';assert.equal(await page.evaluate(()=>window.readRetained()),true);assert.equal(providerRequests.length,beforeRetained+2);
 await page.evaluate(()=>window.clearRetained());assert.equal(await page.evaluate(()=>window.readRetained()),false);assert.equal(providerRequests.length,beforeRetained+2);
 // Actual Chromium admission failures must produce no application fetch or provider request.
 mode='normal';const beforeAdmission=providerRequests.length,fetchBeforeAdmission=await page.evaluate(()=>window.fetchCalls());
 const refusals=await page.evaluate(endpoint=>window.admissionRefusals(endpoint),providerOrigin);
 assert.deepEqual(refusals,{consent:Array(32).fill(true),bindings:Array(6).fill(true),cids:Array(2).fill(true)});
 assert.equal(await page.evaluate(()=>window.fetchCalls()),fetchBeforeAdmission);
 assert.equal(providerRequests.length,beforeAdmission,'invalid admission cannot reach provider');
 assert.equal(await page.evaluate(()=>window.validAfterRefusals()),true);
 assert.equal(await page.evaluate(()=>window.fetchCalls()),fetchBeforeAdmission+1);
 assert.equal(providerRequests.length,beforeAdmission+1,'valid request retains full allowance after refusals');
 // Server withholds the acknowledgement; abort and browser closure must end the connection.
 mode='hold-upload';let seen=new Promise(resolve=>{noticed=resolve;}),gone=new Promise(resolve=>{closed=resolve;});
 await page.evaluate(endpoint=>window.beginUpload(endpoint),providerOrigin);await bounded(seen);
 assert.equal(await page.evaluate(()=>window.cancelUpload()),true);await bounded(gone);
 seen=new Promise(resolve=>{noticed=resolve;});gone=new Promise(resolve=>{closed=resolve;});
 await page.evaluate(endpoint=>window.beginUpload(endpoint),providerOrigin);await bounded(seen);
 await browser.close();browser=undefined;await bounded(gone);
 assert.deepEqual(appRequests.sort(),['/','/','/','/app.js','/app.js','/app.js']);assert.equal(providerRequests.length,31+networkRetries);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('Direct Kubo browser success, consent/rate refusal, provider faults and interrupted acknowledgements passed (protocol substitute).');
}finally{await browser?.close();for(const server of [app,provider])if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
