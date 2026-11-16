// CI-only component contract. Mock service/client boundaries; native storage is
// covered separately. This does not qualify a hosted person, passkey or reader.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('CI only');
const mocks={
 '@/lib/identity/device-client':`export async function readDeviceSession(){return {authorized:true,linkedOidcEnabled:true,context:'ui-person-context',expiresAt:Date.now()+300000};}
 export function createDeviceClient(session,origin,refresh){let disposed=false;return {adapters:{},dispose(){disposed=true;window.fixture.disposals++;},async restoreCompleteSource(bytes){window.fixture.restores++;if(window.fixture.pending)await new Promise(resolve=>window.fixture.release=resolve);if(disposed)throw Error('cancelled');window.fixture.rows=[{address:'restored',identity:{principal:'existing-principal'}}];refresh();return 'stored';},async restoreEncryptedSource(bytes,passphrase){window.fixture.recoveryBytes=passphrase;window.fixture.recoveries++;if(window.fixture.pending)await new Promise(resolve=>window.fixture.release=resolve);if(disposed)throw Error('cancelled');return 'existing';},async prepareEncryptedCopy(passphrase,handle){window.fixture.preparedPass=passphrase;window.fixture.preparedHandle=handle;return new TextEncoder().encode('{"version":1,"ciphertext":"synthetic"}');},async signInRestored(){window.fixture.signins++;return false;}};}`,
 '@/lib/identity/restored-keyring-storage':`export async function restoredKeyringRecords(){return window.fixture.rows;}`,
 '@/lib/identity/device-storage':`export async function deviceRecords(){return [];}`,
 '@/lib/identity/unlocked-mesh':`export function subscribeUnlockedMeshPair(){return ()=>{};}`,
 './useIdentitySession':`export function identitySessionChanged(){}`,
 'sea-device-link-ui':`export function ReceiverFlow(){return null;}export function SenderFlow(){return null;}`,
 'sea-device-link-ui/styles.css':''
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {DeviceTransfer} from './components/DeviceTransfer';window.fixture={rows:[],restores:0,recoveries:0,signins:0,disposals:0,pending:false,linked:[],linkedPending:false,linkedAborts:0};window.fetch=async(url,options)=>{window.fixture.linked.push({url,context:new Headers(options.headers).get('X-Device-Context')});if(window.fixture.linkedPending)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{window.fixture.linkedAborts++;reject(Error('cancelled'));},{once:true}));return Response.json(String(url).endsWith('cancel')?{status:'local-cleared-remote-unknown'}:{ok:true});};createRoot(document.getElementById('root')).render(<DeviceTransfer/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'isolated-ui-boundaries',setup(b){b.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<div id="root"></div><script src="/app.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const restore=page.getByRole('button',{name:'Protect and restore existing identity',exact:true});
 await page.getByRole('button',{name:'Restore existing keyring',exact:true}).click();
 assert.equal(await restore.isDisabled(),true);
 const select=()=>page.getByLabel('Existing complete keyring export').setInputFiles({name:'existing.json',mimeType:'application/json',buffer:Buffer.from('{"synthetic":"complete keyring boundary"}')});
 await select();await restore.click();await page.getByRole('heading',{name:'Restored identity',exact:true}).waitFor();
 assert.match(await page.getByRole('status').innerText(),/saved with local passkey/);
 await page.getByRole('button',{name:'Unlock restored identity and sign in',exact:true}).click();
 await page.getByText('Restored identity is preserved; sign-in failed. Retry without restoring again.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.restores),1);assert.equal(await page.evaluate(()=>window.fixture.signins),1);
 await page.evaluate(()=>{window.fixture.pending=true;});await select();await restore.click();
 await page.getByRole('button',{name:'Cancel current identity operation',exact:true}).click();
 await page.evaluate(()=>window.fixture.release());
 await page.getByRole('button',{name:'Restore existing keyring',exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>window.fixture.disposals)>0);assert.equal(await page.evaluate(()=>window.fixture.rows.length),1);
 await page.getByRole('button',{name:'Complete linked account sign-in',exact:true}).click();
 await page.getByText('Signed in through the existing linked account.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Cancel linked account attempt',exact:true}).click();
 await page.getByText('Local attempt cleared. Remote cancellation could not be confirmed; the original attempt will expire.',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.linked.map(v=>v.context)),['ui-person-context','ui-person-context']);
 await page.evaluate(()=>{window.fixture.linkedPending=true;});
 await page.getByRole('button',{name:'Complete linked account sign-in',exact:true}).click();
 await page.getByRole('button',{name:'Cancel current identity operation',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.linkedAborts===1);
 await page.evaluate(()=>{window.fixture.pending=false;window.fixture.linkedPending=false;});
 await page.getByRole('button',{name:'Open encrypted recovery copy',exact:true}).click();
 await page.getByLabel('Encrypted recovery file').setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:Buffer.from('{"synthetic":"encrypted boundary"}')});
 await page.getByLabel('Recovery passphrase',{exact:true}).fill('password');
 await page.getByRole('button',{name:'Open and protect recovery copy',exact:true}).click();
 await page.getByText('A matching saved copy already exists. Unlock it below; no new passkey was created.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Recovery passphrase',{exact:true}).inputValue(),'');
 assert.equal(await page.evaluate(()=>window.fixture.recoveries),1);
 assert.equal(await page.evaluate(()=>window.fixture.recoveryBytes.every(b=>b===0)),true);
 assert.equal(await page.evaluate(()=>window.fixture.linked.some(v=>JSON.stringify(v).includes('password'))),false);
 await page.getByRole('button',{name:'Create encrypted recovery copy',exact:true}).click();
 await page.getByLabel('New recovery passphrase',{exact:true}).fill('strong synthetic copy phrase');
 await page.getByLabel('Confirm recovery passphrase',{exact:true}).fill('different');
 await page.getByRole('button',{name:'Prepare encrypted recovery file',exact:true}).click();
 await page.getByText('Passphrases did not match. Enter both again.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('New recovery passphrase',{exact:true}).inputValue(),'');
 await page.getByLabel('Account handle (if you use one)',{exact:true}).fill('public-handle');
 await page.getByLabel('New recovery passphrase',{exact:true}).fill('strong synthetic copy phrase');
 await page.getByLabel('Confirm recovery passphrase',{exact:true}).fill('strong synthetic copy phrase');
 await page.getByRole('button',{name:'Prepare encrypted recovery file',exact:true}).click();
 await page.getByRole('link',{name:'Download encrypted recovery file',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.preparedHandle),'public-handle');
 assert.equal(await page.evaluate(()=>window.fixture.preparedPass.every(b=>b===0)),true);
 assert.equal(await page.getByLabel('Confirm recovery passphrase',{exact:true}).inputValue(),'');
 assert.deepEqual(errors,[]);console.log('Restore UI: explicit import, independent failed sign-in, preserved copy and cancellation passed');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
