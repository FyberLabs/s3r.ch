// Native encrypted browser-attempt and issuer contracts: CI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedSessionFixture} from '../../scripts/fixtures/linked-session';
import {createLinkedOidcBrowserFlow} from './linked-oidc-browser-flow';
async function setup(){
 const f=await linkedSessionFixture('oidc');if(f.credential.kind!=='oidc')throw Error();
 const origin='https://s3r.ch',providerOrigin='https://id.example';let context='person-context',now=200,saved=false,lost=false,cancelled=false,exchanges=0;
 const broker={async start(token:string){return {authorizationUrl:providerOrigin+'/authorize?state='+('s'.repeat(43)),state:'s'.repeat(43),expiresAt:260};},
  async exchange(){exchanges++;if(cancelled)throw Error();saved=true;if(lost)throw Error('lost');},
  async finish(token:string){if(!saved||cancelled)throw Error();const result=await f.sessions.exchangeLinked(token,await f.proof(token));if(!result)throw Error();return result;},
  async cancel(){cancelled=true;}};
 const flow=createLinkedOidcBrowserFlow({origin,providerOrigin,configDigest:'a'.repeat(64),secret:'x'.repeat(32),sessions:f.sessions,broker,
  person:async()=>({credential:f.credential as any,context,expiresAt:500}),clock:()=>now});
 const request=(action:string,body:unknown={},cookie='',from=origin)=>new Request(origin+'/api/identity/linked-oidc/'+action,{method:'POST',headers:{origin:from,'x-device-context':context,'content-type':action==='callback'?'application/x-www-form-urlencoded':'application/json',cookie},body:action==='callback'?String(body):JSON.stringify(body)});
 const start=async()=>{const response=await flow(request('start'),'start');assert.equal(response.status,200);return response.headers.getSetCookie()[0].split(';')[0];};
 return {f,flow,request,start,providerOrigin,change:()=>context='changed',expire:()=>{now=260;f.advance();},lose:()=>lost=true,exchanges:()=>exchanges};
}
test('browser attempt binds provider state and returns only same-issuer cookie after separate completion',async()=>{
 const h=await setup(),cookie=await h.start();assert.ok(!cookie.includes(h.f.principal));
 const callback=await h.flow(h.request('callback','state='+('s'.repeat(43))+'&code=provider-code',cookie,h.providerOrigin),'callback');
 assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'https://s3r.ch/identity/devices?linked=ready');assert.equal(callback.headers.getSetCookie().length,0);
 const done=await h.flow(h.request('finish',{},cookie),'finish');assert.equal(done.status,200);assert.deepEqual(await done.json(),{ok:true});
 const session=done.headers.getSetCookie().find(c=>c.startsWith('__Host-s3rch-squad-session='))!.split(';')[0].split('=')[1];assert.deepEqual(await h.f.sessions.authenticate(session),{key:h.f.principal});
 assert.equal((await h.flow(h.request('finish',{},cookie),'finish')).status,503);
});
test('lost provider response recovers through saved proof without another code exchange',async()=>{
 const h=await setup(),cookie=await h.start();h.lose();
 assert.equal((await h.flow(h.request('callback','state='+('s'.repeat(43))+'&code=provider-code',cookie,h.providerOrigin),'callback')).status,503);
 assert.equal((await h.flow(h.request('finish',{},cookie),'finish')).status,200);assert.equal(h.exchanges(),1);
});
test('origin, state, duplicate fields and changed person context refuse',async()=>{
 for(const body of ['state=wrong&code=code','state='+('s'.repeat(43))+'&state=duplicate&code=code','state='+('s'.repeat(43))+'&code=code&iss=https%3A%2F%2Fforeign.example']){
  const h=await setup(),cookie=await h.start();assert.equal((await h.flow(h.request('callback',body,cookie,h.providerOrigin),'callback')).status,503);assert.equal(h.exchanges(),0);
 }
 const h=await setup(),cookie=await h.start();
 assert.equal((await h.flow(h.request('finish',{},cookie,'https://foreign.example'),'finish')).status,403);
 assert.equal((await h.flow(h.request('start',{},cookie),'start')).status,409);
 await h.flow(h.request('callback','state='+('s'.repeat(43))+'&code=code',cookie,h.providerOrigin),'callback');h.change();
 assert.equal((await h.flow(h.request('finish',{},cookie),'finish')).status,503);
});
test('cancel and expired local cleanup never claim an unconfirmed remote cancellation',async()=>{
 const h=await setup(),cookie=await h.start();const cancelled=await h.flow(h.request('cancel',{},cookie),'cancel');assert.deepEqual(await cancelled.json(),{status:'cancelled'});assert.match(cancelled.headers.getSetCookie()[0],/Max-Age=0/);
 assert.equal((await h.flow(h.request('finish',{},cookie),'finish')).status,503);
 const g=await setup(),old=await g.start();g.expire();const expired=await g.flow(g.request('cancel',{},old),'cancel');assert.deepEqual(await expired.json(),{status:'local-cleared-remote-unknown'});
});
