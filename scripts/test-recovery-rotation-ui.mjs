// Component contracts execute only in CI.
import assert from 'node:assert/strict';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('CI only');
const mocks={
 'sociacl-ids/recovery':`export class RecoveryWeakPassphraseError extends Error{};export const encodePassphrase=v=>new TextEncoder().encode(v);`,
 '@/lib/identity/recovery-wallet':`export async function connectRecoveryWallet(provider,signal,onChange){window.fixture.changeWallet=onChange;return {current:()=>({address:'linked-wallet'}),close(){},signMessage:async()=>''};}`,
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {RecoveryRotation} from './components/RecoveryRotation';
window.ethereum={};window.fixture={calls:[],closed:0};const f=window.fixture;
const client={cancelRotation(){f.cancelled=(f.cancelled??0)+1;},async prepareRotation(previous,devices,lost,phrase,account){f.previous=previous;f.phrase=phrase;f.calls.push('prepare');let phase='prepared';return {get phase(){return phase;},close(){f.closed++;},file:()=>new TextEncoder().encode('encrypted'),async save(){f.calls.push('save');phase='saved';},async authorize(){f.calls.push('authorize');phase='authorized';},async publish(){f.calls.push('publish');phase='published';},async protect(){f.calls.push('protect');phase='stored';}};}};
createRoot(document.getElementById('root')).render(<RecoveryRotation client={client} previous={{sealed:'displayed'}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}));}}]});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script>'+bundle.outputFiles[0].text+'</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
 const button=name=>page.getByRole('button',{name,exact:true});
 assert.equal(await button('Publish and confirm rotation').isDisabled(),true);
 await page.getByLabel('Lost device ID',{exact:true}).fill('lost');await page.getByLabel('Trusted device IDs, one per line (include the lost device)',{exact:true}).fill('lost\nkept');
 await page.getByLabel('New rotation recovery passphrase',{exact:true}).fill('new phrase');await page.getByLabel('Confirm rotation recovery passphrase',{exact:true}).fill('new phrase');
 await button('Prepare recovery rotation').click();await page.getByRole('link',{name:'Download pending recovery backup'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls),['prepare']);assert.equal(await page.evaluate(()=>window.fixture.phrase.every(b=>b===0)),true);
 assert.equal(await page.getByLabel('New rotation recovery passphrase',{exact:true}).inputValue(),'');
 await button('Save pending rotation backup').click();await button('Authorize rotation with linked wallet').click();await button('Publish and confirm rotation').click();await button('Protect confirmed rotated keys').click();
 await page.getByText('Confirmed new keys are protected locally.',{exact:false}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls),['prepare','save','authorize','publish','protect']);
 await button('Cancel rotation attempt').click();assert.equal(await button('Publish and confirm rotation').isDisabled(),true);assert.ok(await page.evaluate(()=>window.fixture.closed)>0);
 await page.getByLabel('New rotation recovery passphrase',{exact:true}).fill('next phrase');await page.getByLabel('Confirm rotation recovery passphrase',{exact:true}).fill('next phrase');
 await button('Prepare recovery rotation').click();await button('Save pending rotation backup').click();await button('Authorize rotation with linked wallet').click();
 await page.evaluate(()=>window.fixture.changeWallet());assert.equal(await button('Publish and confirm rotation').isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(v=>v==='publish').length),1);assert.deepEqual(errors,[]);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
