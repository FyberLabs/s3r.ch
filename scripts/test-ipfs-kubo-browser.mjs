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
 import {rawMediaBlockCid} from './lib/ipfs-media-blocks';
 import {sealMedia} from './lib/media-crypto';
 window.exercise=async endpoint=>{
  let allowed=true;const abort=new AbortController();
  const client=createKuboBlockClient({endpoint,maxBytes:1024,current:()=>allowed,signal:abort.signal});
  const sealed=await sealMedia(new Uint8Array([7,8,9]),{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'12'.repeat(32)});
  const cid=await client.put(sealed.bytes);const result=await client.get(cid,sealed.bytes.length);
  allowed=false;let refused=false;try{await client.get(cid,result.length);}catch{refused=true;}
  return {cid,expected:await rawMediaBlockCid(sealed.bytes),same:Array.from(result).join()===Array.from(sealed.bytes).join(),refused};
 };`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'browser',format:'iife'});
 const appRequests=[],providerRequests=[],errors=[];let appOrigin,stored;
 app=createServer(tls,(req,res)=>{appRequests.push(req.url);res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].contents:'<!doctype html><link rel="icon" href="data:,"><script src="/app.js"></script>');});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));appOrigin=`https://127.0.0.1:${app.address().port}`;
 provider=createServer(tls,async(req,res)=>{
  try {
   providerRequests.push(req.url);assert.equal(req.method,'POST');assert.equal(req.headers.origin,appOrigin);assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.referer,undefined);
   res.setHeader('Access-Control-Allow-Origin',appOrigin);
   const url=new URL(req.url,'https://fixture.invalid');
   if(url.pathname==='/api/v0/block/put'){
    assert.equal(url.searchParams.get('pin'),'false');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const form=await new Request('https://fixture.invalid',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();
    stored=Buffer.from(await form.get('file').arrayBuffer());
    // CID calculation uses the same public raw codec, executed by the browser separately.
    const {createHash}=await import('node:crypto');const raw=Buffer.concat([Buffer.from([1,0x55,0x12,32]),createHash('sha256').update(stored).digest()]);
    let bits=0,value=0,cid='b';for(const byte of raw){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;cid+='abcdefghijklmnopqrstuvwxyz234567'[(value>>>bits)&31];}value&=(1<<bits)-1;}if(bits)cid+='abcdefghijklmnopqrstuvwxyz234567'[(value<<(5-bits))&31];
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({Key:cid,Size:stored.length}));
   }else{assert.equal(url.pathname,'/api/v0/block/get');assert.ok(stored);res.end(stored);}
  }catch(error){errors.push(String(error));res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));const providerOrigin=`https://127.0.0.1:${provider.address().port}`;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const unexpected=[];await context.route('**/*',async route=>{const origin=new URL(route.request().url()).origin;if(origin===appOrigin||origin===providerOrigin)return route.continue();unexpected.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(appOrigin);await page.waitForFunction(()=>!!window.exercise);
 const result=await page.evaluate(endpoint=>window.exercise(endpoint),providerOrigin);
 assert.equal(result.cid,result.expected);assert.equal(result.same,true);assert.equal(result.refused,true);
 assert.deepEqual(appRequests.sort(),['/','/app.js']);assert.equal(providerRequests.length,2);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('Direct browser Kubo transfer and consent refusal passed (protocol substitute).');
}finally{await browser?.close();for(const server of [app,provider])if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
