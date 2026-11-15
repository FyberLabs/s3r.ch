import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {writeNightlyCaseResults} from './nightly-case-results.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_EVENT_NAME!=='schedule'||process.env.NIGHTLY_SUITE!=='s3rch-contact-inbox-ui')throw Error('Requires isolated central scheduled contacts UI suite');
const names=['setup','explicit-acceptance','ambiguous-send-retry','peer-message','block','identity-and-lock-isolation','cleanup'];
const outcomes=new Map();let active='setup',browser,server;
function next(name){outcomes.set(active,'passed');active=name;}
try{
 const bundle=await build({entryPoints:['scripts/fixtures/contact-inbox.tsx'],bundle:true,write:false,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
 server=createServer((req,res)=>{res.setHeader('cache-control','no-store');if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');}else{res.statusCode=404;res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 const page=await browser.newPage();await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 await page.goto(origin);await page.getByText('Hello Alice',{exact:true}).waitFor();
 next('explicit-acceptance');assert.equal(await page.getByLabel('Contact conversation').count(),0);
 await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByText('No pending requests.').waitFor();
 await page.getByRole('button',{name:'fixture-bob',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('Private draft');
 next('ambiguous-send-retry');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('button',{name:'Retry message',exact:true}).waitFor();await page.getByRole('button',{name:'Retry message',exact:true}).click();
 await page.getByText('Private draft',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.contactFixture.counts()),{prepared:1,submitted:2,rows:1});
 next('peer-message');await page.evaluate(()=>window.contactFixture.peerMessage());await page.getByRole('button',{name:'fixture-bob',exact:true}).click();await page.getByText('Hello back',{exact:true}).waitFor();
 next('block');await page.getByRole('button',{name:'Block',exact:true}).click();await page.getByText('Blocked',{exact:true}).waitFor();assert.equal(await page.getByLabel('Contact conversation').count(),0);
 assert.equal(await page.evaluate(()=>{try{window.contactFixture.peerMessage();return false;}catch{return true;}}),true);
 next('identity-and-lock-isolation');await page.evaluate(()=>window.contactFixture.reset());await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByRole('button',{name:'fixture-bob',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('Do not carry this draft');
 await page.getByRole('button',{name:'Switch identity',exact:true}).click();await page.getByText('No contacts yet.').waitFor();assert.equal(await page.getByLabel('Message',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Switch identity',exact:true}).click();await page.getByRole('button',{name:'fixture-bob',exact:true}).click();assert.equal(await page.getByLabel('Message',{exact:true}).inputValue(),'');
 await page.evaluate(()=>window.contactFixture.lock());await page.getByText('Unlock your contact session to continue.').waitFor();assert.equal(await page.getByLabel('Message',{exact:true}).count(),0);
 next('cleanup');
}catch{outcomes.set(active,'failed');process.exitCode=1;}
finally{
 try{await browser?.close();if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(active==='cleanup')outcomes.set('cleanup','passed');}catch{outcomes.set('cleanup','failed');process.exitCode=1;}
 writeNightlyCaseResults({suite:'s3rch-contact-inbox-ui',expectedCases:names,cases:names.map(name=>({name,status:outcomes.get(name)??'blocked'}))});
}
