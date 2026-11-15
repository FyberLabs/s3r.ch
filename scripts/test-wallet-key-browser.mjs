// CI-only local browser contract. Synthetic wallet; real SEA, IDB and signatures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('CI only');
const fixtureWallet='0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const bundle=await build({stdin:{contents:`
import {privateKeyToAccount} from 'viem/accounts';
import {ensureLocalMeshKey,MeshKeySetupError} from './lib/identity/mesh';
import {createIndexedDbMeshKeyStore} from './lib/identity/idb';
import {exportOwnerLinkEvidence} from './lib/identity/owner-link-evidence';
import {exportOperatorBinding} from './lib/identity/operator-binding-export';
const account=privateKeyToAccount('0x'+'0'.repeat(63)+'1');
window.exercise=async()=>{
 const input={address:account.address,domain:'test.s3r.ch',uri:'https://test.s3r.ch',signMessage:message=>account.signMessage({message})};
 const mesh=await ensureLocalMeshKey(input);
 const again=await ensureLocalMeshKey({...input,signMessage:async()=>{throw Error('must reuse')}});
 const evidence=await exportOwnerLinkEvidence(mesh.record,account.address,input.uri);
 const exported=await exportOperatorBinding({address:account.address,origin:input.uri,pair:mesh.record.seaPair,current:()=>true,signWallet:input.signMessage,timestamp:1700000000});
 return {created:mesh.created,reused:again.record.seaPub===mesh.record.seaPub,evidence:!!evidence,doc:JSON.parse(exported),leaks:exported.includes(mesh.record.seaPair.priv)||exported.includes(mesh.record.seaPair.epriv)};
};
window.failure=async()=>{
 const address='0x0000000000000000000000000000000000000001';
 try {await ensureLocalMeshKey({address,domain:'test.s3r.ch',uri:'https://test.s3r.ch',signMessage:async()=>{throw Error('PRIVATE ERROR')}});}catch(e){return {reason:e.message,empty:await createIndexedDbMeshKeyStore().get(address)===null};}
};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-declared-wallet-only',setup(b){b.onLoad({filter:/operator-binding-export\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('0x4C8d36f87287e75D3D84F1aeD72655ecCbC7A1A7',fixtureWallet),loader:'ts'}));}}]});
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<script src="/app.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try {browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(()=>window.exercise());assert.equal(result.created,true);assert.equal(result.reused,true);assert.equal(result.evidence,true);assert.equal(result.leaks,false);assert.equal(result.doc.enabled,false);assert.equal(result.doc.proofs.length,1);
 const failure=await page.evaluate(()=>window.failure());assert.equal(failure.empty,true);assert.match(failure.reason,/Wallet link signature/);assert.ok(!failure.reason.includes('PRIVATE'));
 console.log('Wallet key creation/reuse/public exports and rejected-signature atomicity passed; synthetic wallet, local browser only');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
