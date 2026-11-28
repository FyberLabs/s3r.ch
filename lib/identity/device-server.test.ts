import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deviceConfig} from './device-config';
import {deviceServer} from './device-server';
import {sameScope,publicRelayPayload,publicBinding} from './device-public';
const origin='https://s3r.ch',scope={sourceOrigin:origin,destinationOrigin:origin,application:'s3r.ch',tenant:'11111111-1111-1111-1111-111111111111',audience:'device'};
const configured={v:1,scope,auth:'https://auth.example/auth/sea-device-link/v1/',acl:'https://acl.example/api/v1/acl/sociacl/device-transfer/',provider:'panopticon'};
const env={S3RCH_DEVICE_TRANSFER_CONFIG:JSON.stringify(configured),S3RCH_OAUTH_ISSUER:'https://issuer.example/realm',S3RCH_SESSION_SIGNING_KEY:'x'.repeat(40)};
test('exact configured origins and endpoints required',()=>{
 assert.ok(deviceConfig(origin,env));for(const change of [{scope:{...scope,application:'other'}},{auth:'http://auth.example/auth/sea-device-link/v1/'},{scope:{...scope,private:'secret'}},{provider:'missing'}])assert.equal(deviceConfig(origin,{...env,S3RCH_DEVICE_TRANSFER_CONFIG:JSON.stringify({...configured,...change})}),null);
 assert.equal(deviceConfig('https://other.example',env),null);assert.equal(deviceConfig(origin,{}),null);
});
test('no bearer is inferred from ordinary cookies; missing origin and unknown actions cannot call owners',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw Error();};
 for(const cookie of ['', 's3rch-session=ordinary; s3rch-startup=ordinary']){
  const config=await deviceServer(new Request(origin+'/api/identity/device/config',{headers:{cookie}}),'config',env,fetcher);assert.equal((await config.json()).authorized,false);
  const denied=await deviceServer(new Request(origin+'/api/identity/device/state',{method:'POST',headers:{Origin:origin,cookie,'Content-Type':'application/json'},body:'{}'}),'state',env,fetcher);assert.equal(denied.status,401);
 }
 assert.equal((await deviceServer(new Request(origin,{method:'POST'}),'relay',env,fetcher)).status,403);
 assert.equal((await deviceServer(new Request(origin),'other',env,fetcher)).status,404);assert.equal(calls,0);
});
test('public allowlist rejects nested private material; scope order is irrelevant',()=>{
 const request={v:1,session:'s',receiverKey:'x'.repeat(87),expiresAt:100,scope};
 assert.ok(sameScope(scope,Object.fromEntries(Object.entries(scope).reverse())));
 assert.ok(publicRelayPayload('create',{request,joinHash:'h'},scope,'s'));
 assert.equal(publicRelayPayload('create',{request:{...request,priv:'secret'},joinHash:'h'},scope,'s'),false);
 assert.equal(publicRelayPayload('send',{transcript:'t',iv:'iv',ciphertext:'encrypted',keyring:'secret'},scope,'s'),false);
 assert.equal(publicBinding({session:'s',transcript:'t',expiresAt:100,scope,identity:{principal:'p',pub:'p',epub:'e',rotationSeq:0,priv:'secret'}},scope),false);
});
