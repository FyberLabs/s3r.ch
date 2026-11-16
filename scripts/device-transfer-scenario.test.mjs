import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceTransferScenario} from './device-transfer-scenario.mjs';
for(const method of ['qr','file'])test(`owner scenario supports ${method} without copying transfer flow`,async()=>{
 const calls=[];let deleted=false;
 const download={path:async()=>'/private/request',delete:async()=>{deleted=true;}};
 function page(name){
  const locator=label=>({click:async()=>calls.push(name+':'+label),waitFor:async()=>{},fill:async()=>{},setInputFiles:async()=>calls.push('file'),textContent:async()=>Array(8).fill('1234abcd').join('-')});
  return {goto:async()=>{},getByRole:(role,options)=>locator(options.name),getByLabel:locator,getByText:locator,locator,
   waitForEvent:async()=>download,route:async()=>{},unroute:async()=>{},reload:async()=>{}};
 }
 const checkpoints=[];let imported=false;
 await deviceTransferScenario({source:page('source'),receiver:page('receiver'),origin:'https://example.test',authenticate:async()=>{},unlockSource:async()=>{},completePrf:async()=>{},scanQr:async()=>calls.push('scan'),assertIdentityAndAccess:async value=>{imported=value.imported;}},{method,cancelFirst:false,checkpoint:async name=>checkpoints.push(name)});
 assert.equal(imported,true);assert.deepEqual(checkpoints,['invited','confirmed','sent']);
 assert.equal(calls.includes('file'),method==='file');assert.equal(calls.includes('scan'),method==='qr');assert.equal(deleted,method==='file');
 assert.ok(calls.includes('source:Send encrypted identity'));
});
