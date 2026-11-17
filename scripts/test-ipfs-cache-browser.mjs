// CI-only loopback contract: real Chromium/IndexedDB/Web Crypto, synthetic consent and clock.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('CI only');
const bundle=await build({stdin:{contents:`
import {createLocalCiphertextCache} from './lib/ipfs-local-cache';
import {rawMediaBlockCid} from './lib/ipfs-media-blocks';
import {sealMedia} from './lib/media-crypto';
let cache, current=true, at=1700000000000;
window.fixture={
 async sample(){const sealed=await sealMedia(new Uint8Array([7,8,9]),{tenant:'afee9b29-1706-5590-bbbf-e58df8945ac0',object:'claim_'+'12'.repeat(32)});return {cid:await rawMediaBlockCid(sealed.bytes),bytes:Array.from(sealed.bytes)};},
 configure(scope,maxBytes,enabled=true,maxEntries=1){cache?.close();current=true;at=1700000000000;cache=createLocalCiphertextCache({scope:scope.repeat(64),policy:{enabled,maxBytes,maxEntries,ttlMs:1000},current:()=>current,now:()=>at});},
 async put(sample){try{await cache.put(sample.cid,new Uint8Array(sample.bytes));return true;}catch{return false;}},
 async get(cid){try{const value=await cache.get(cid);return value?Array.from(value):null;}catch{return 'unavailable';}},
 time(value){at=value;}, consent(value){current=value;},
 async evict(cids){await cache.evict(cids);},
 async clear(){await cache.clear();}, close(){cache.close();},
 async databases(){return (await indexedDB.databases()).map(db=>db.name);}
};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'browser',format:'iife'});
const server=createServer((req,res)=>{
 if(req.method!=='GET'||!['/','/app.js'].includes(req.url)){res.writeHead(404);res.end();return;}
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');
 res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<!doctype html><link rel="icon" href="data:,"><script src="/app.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`, profile=await mkdtemp(join(tmpdir(),'s3rch-ciphertext-cache-'));
const unexpected=[],errors=[];let context;
async function launch(){
 context=await chromium.launchPersistentContext(profile,{headless:true,serviceWorkers:'block'});
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
  if(url.origin===origin&&request.method()==='GET'&&['/','/app.js'].includes(url.pathname)&&!url.search){await route.continue();return;}
  unexpected.push(request.url());await route.abort();
 });
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
}
async function page(scope,maxBytes=35,enabled=true,maxEntries=1){const p=await context.newPage();await p.goto(origin);await p.waitForFunction(()=>!!window.fixture);
 await p.evaluate(({scope,maxBytes,enabled,maxEntries})=>window.fixture.configure(scope,maxBytes,enabled,maxEntries),{scope,maxBytes,enabled,maxEntries});return p;}
try {
 await launch();
 const disabled=await page('c',35,false);let sample=await disabled.evaluate(()=>window.fixture.sample());
 assert.equal(await disabled.evaluate(sample=>window.fixture.put(sample),sample),false);
 assert.deepEqual(await disabled.evaluate(()=>window.fixture.databases()),[],'opt-out must not create a DB');
 const a=await page('a'),b=await page('b');
 const results=await Promise.all([a,b].map(p=>p.evaluate(sample=>window.fixture.put(sample),sample)));
 assert.equal(results.filter(Boolean).length,1,'tabs must share one byte/entry budget');
 const winner=results[0]?'a':'b',loser=results[0]?'b':'a',winnerPage=results[0]?a:b,loserPage=results[0]?b:a;
 assert.deepEqual(await winnerPage.evaluate(cid=>window.fixture.get(cid),sample.cid),sample.bytes);
 assert.equal(await loserPage.evaluate(cid=>window.fixture.get(cid),sample.cid),null,'CID knowledge is not local partition access');
 await winnerPage.reload();await winnerPage.waitForFunction(()=>!!window.fixture);
 await winnerPage.evaluate(scope=>window.fixture.configure(scope,35),winner);
 assert.deepEqual(await winnerPage.evaluate(cid=>window.fixture.get(cid),sample.cid),sample.bytes,'page reload must retain committed bytes');
 // Close the actual browser process, then reopen its isolated profile at the same origin.
 await context.close();context=undefined;await launch();
 const reopened=await page(winner);
 assert.deepEqual(await reopened.evaluate(cid=>window.fixture.get(cid),sample.cid),sample.bytes,'browser restart must retain committed bytes');
 await reopened.evaluate(()=>window.fixture.time(1700000000500));
 assert.equal(await reopened.evaluate(sample=>window.fixture.put(sample),sample),true);
 await reopened.evaluate(()=>window.fixture.time(1700000001000));
 const expiredCid=sample.cid;sample=await reopened.evaluate(()=>window.fixture.sample());
 assert.notEqual(sample.cid,expiredCid);
 // No read may sweep expiry first: the distinct insert must reclaim the full budget.
 assert.equal(await reopened.evaluate(sample=>window.fixture.put(sample),sample),true,'put must reclaim expired quota and retries must not extend TTL');
 assert.equal(await reopened.evaluate(cid=>window.fixture.get(cid),expiredCid),null);
 assert.deepEqual(await reopened.evaluate(cid=>window.fixture.get(cid),sample.cid),sample.bytes);
 await reopened.evaluate(()=>window.fixture.consent(false));
 assert.equal(await reopened.evaluate(cid=>window.fixture.get(cid),sample.cid),'unavailable');
 await reopened.evaluate(async()=>{window.fixture.close();window.fixture.time(0);await window.fixture.clear();});
 const clean=await page(winner);await clean.evaluate(()=>window.fixture.time(1700000001000));
 assert.equal(await clean.evaluate(cid=>window.fixture.get(cid),sample.cid),null,'cleanup survives opt-out, close and rollback');
 const other=await page(loser);await other.evaluate(()=>window.fixture.time(1700000001000));
 assert.equal(await other.evaluate(sample=>window.fixture.put(sample),sample),true);
 await clean.evaluate(()=>window.fixture.clear());
 assert.deepEqual(await other.evaluate(cid=>window.fixture.get(cid),sample.cid),sample.bytes,'cleanup must preserve other partitions');
 // Targeted cleanup frees one slot and preserves both unrelated local data and the same CID elsewhere.
 await clean.evaluate(scope=>{window.fixture.configure(scope,105,true,3);window.fixture.time(1700000001000);},winner);
 const unrelated=await clean.evaluate(()=>window.fixture.sample()),replacement=await clean.evaluate(()=>window.fixture.sample());
 assert.equal(await clean.evaluate(sample=>window.fixture.put(sample),sample),true);
 assert.equal(await clean.evaluate(sample=>window.fixture.put(sample),unrelated),true);
 assert.equal(await clean.evaluate(sample=>window.fixture.put(sample),replacement),false,'aggregate cache is full');
 await clean.evaluate(async cid=>{window.fixture.consent(false);window.fixture.close();window.fixture.time(0);await window.fixture.evict([cid]);},sample.cid);
 await clean.reload();await clean.waitForFunction(()=>!!window.fixture);
 await clean.evaluate(scope=>{window.fixture.configure(scope,105,true,3);window.fixture.time(1700000001000);},winner);
 assert.equal(await clean.evaluate(cid=>window.fixture.get(cid),sample.cid),null,'eviction persists across reload');
 assert.deepEqual(await clean.evaluate(cid=>window.fixture.get(cid),unrelated.cid),unrelated.bytes);
 assert.deepEqual(await other.evaluate(cid=>window.fixture.get(cid),sample.cid),sample.bytes,'same CID in another partition is retained');
 assert.equal(await clean.evaluate(sample=>window.fixture.put(sample),replacement),true,'eviction reclaims byte and entry quota');
 assert.deepEqual(unexpected,[],'cache must not contact providers or cloud endpoints');assert.deepEqual(errors,[]);
 console.log('PASS: real Chromium ciphertext cache opt-out, cross-tab quota, restart persistence, expiry and scoped/targeted cleanup; synthetic consent/clock, no provider traffic');
}finally{
 await context?.close();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}
