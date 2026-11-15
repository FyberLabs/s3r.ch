import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContactService} from './contact-service';
import fixture from './identity/vectors/contact-acceptance.json';
const owner=fixture.mint.signingPub,peer=fixture.genesis.principal;
const tenant='12345678-1234-1234-1234-123456789abc';
const config={origin:'https://acl.example',tenant,readers:[{principal:owner,apiKey:'contact-test-key'}]};
function request(body:unknown,origin='https://site.example'){return new Request('https://site.example/api/contacts/config',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});}
test('contacts relay binds credentials to the verified reader and keeps them out of responses',async()=>{
 let calls=0;
 const service=createContactService(config,'https://site.example',async()=>owner,(async(url,init)=>{
  calls++;assert.equal(url,'https://acl.example/api/v1/acl/sociacl/contacts/config');
  assert.equal(new Headers(init?.headers).get('X-Api-Key'),'contact-test-key');assert.equal(init?.redirect,'error');
  return Response.json({at:100,tenant,source:tenant,principal:owner,currentKey:owner,trust:{jwks:{keys:[]},policy:{},pinnedIss:[]}});
 }) as typeof fetch,()=>100);
 const result=await service('config',request({evaluatedAt:100}));assert.equal(result.status,200);assert.ok(!(await result.text()).includes('contact-test-key'));assert.equal(calls,1);
 assert.equal((await service('config',request({evaluatedAt:100},'https://attacker.example'))).status,403);assert.equal(calls,1);
 assert.equal((await service('read',request({owner:peer,kind:'vault',evaluatedAt:100}))).status,400);assert.equal(calls,1);
});
test('identity changing while upstream responds withholds the result',async()=>{
 let identity=owner;
 const service=createContactService(config,'https://site.example',async()=>identity,(async()=>{
  identity=peer;return Response.json({at:100,tenant,source:tenant,principal:owner,currentKey:owner,trust:{jwks:{keys:[]},policy:{},pinnedIss:[]}});
 }) as typeof fetch,()=>100);
 assert.equal((await service('config',request({evaluatedAt:100}))).status,403);
});
