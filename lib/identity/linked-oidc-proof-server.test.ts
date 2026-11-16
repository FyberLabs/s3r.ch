// Native issuer/provider and HTTP-boundary contracts run in CI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeJwt} from 'jose';
import {linkedSessionFixture} from '../../scripts/fixtures/linked-session';
import {createLinkedOidcProofClient} from './linked-oidc-proof-server';
async function setup(binding?:{run:string;generation:string}){
 const f=await linkedSessionFixture('oidc');if(f.credential.kind!=='oidc')throw Error();
 const token=(await f.sessions.linkedChallenge(f.credential))!,proof=await f.proof(token,binding?{nightly_run:binding}:{});
 const config={origin:'https://s3r.ch',authOrigin:binding?'https://api.test.hyperme.sh':'https://auth.example',serviceToken:'a'.repeat(43),issuer:f.credential.iss,tenant:f.credential.tenant,clientId:'site',authorizationEndpoint:'https://id.example/authorize',redirectUri:'https://s3r.ch/api/identity/linked-oidc/callback'};
 const calls:string[]=[];let saved=false,cancelled=false,lost=false,mutate=(v:any)=>v;
 const fetcher:typeof fetch=async(url,options)=>{
  if(binding)assert.equal(new Headers(options?.headers).get('X-Nightly-Run-Grant'),'b'.repeat(64));
  assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');
  assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+config.serviceToken);
  const action=String(url).split('/').at(-1)!;calls.push(action);const body=JSON.parse(String(options?.body));
  assert.deepEqual(body.challenge,{...await f.sessions.linkedProofChallenge(token),origin:config.origin});
  if(action==='start'){
   const u=new URL(config.authorizationEndpoint);for(const [k,v] of Object.entries({client_id:config.clientId,response_type:'code',response_mode:'form_post',scope:'openid',redirect_uri:config.redirectUri,state:'s'.repeat(43),nonce:decodeJwt(token).jti!,code_challenge:'p'.repeat(43),code_challenge_method:'S256',prompt:'login',max_age:'0'}))u.searchParams.set(k,v);
   return Response.json(mutate({version:1,authorizationUrl:u.href}));
  }
  if(action==='cancel'){cancelled=true;return Response.json(mutate({version:1,status:'cancelled'}));}
  if(cancelled)return Response.json({error:'refused'},{status:409});
  if(action==='exchange'){assert.equal(body.state,'s'.repeat(43));assert.equal(body.code,'provider-code');saved=true;if(lost)throw Error('lost response');}
  if(!saved)return Response.json({error:'unavailable'},{status:409});
  return Response.json(mutate({version:1,...proof}));
 };
 const client=createLinkedOidcProofClient({config,sessions:f.sessions,fetch:fetcher});
 return {f,token,config,client,calls,signal:new AbortController().signal,lose:()=>lost=true,mutate:(fn:typeof mutate)=>mutate=fn,fetcher};
}
test('original issuer challenge and saved Auth proof yield only the existing SEA issuer session',async()=>{
 const h=await setup(),start=await h.client.start(h.token,h.signal);assert.equal(start.state,'s'.repeat(43));
 assert.equal(await h.client.exchange(h.token,start.state,'provider-code',h.signal),undefined);
 const session=await h.client.finish(h.token,h.signal);assert.deepEqual(await h.f.sessions.authenticate(session),{key:h.f.principal});
 await assert.rejects(h.client.finish(h.token,h.signal));assert.deepEqual(h.calls,['start','exchange','result','result']);
});
test('lost exchange response uses exact proof readback without exchanging the code again',async()=>{
 const h=await setup();h.lose();await assert.rejects(h.client.exchange(h.token,'s'.repeat(43),'provider-code',h.signal));
 assert.ok(await h.client.finish(h.token,h.signal));assert.deepEqual(h.calls,['exchange','result']);
});
test('forged, expired, foreign-provider and cancelled challenges never request proof',async()=>{
 const h=await setup();await assert.rejects(h.client.start(h.token+'x',h.signal));assert.deepEqual(h.calls,[]);
 const other=createLinkedOidcProofClient({config:{...h.config,tenant:'foreign'},sessions:h.f.sessions,fetch:h.fetcher});
 await assert.rejects(other.start(h.token,h.signal));assert.deepEqual(h.calls,[]);
 const abort=new AbortController();abort.abort();await assert.rejects(h.client.start(h.token,abort.signal));assert.deepEqual(h.calls,[]);
 h.f.advance();await assert.rejects(h.client.start(h.token,h.signal));assert.deepEqual(h.calls,[]);
});
test('revoked current authority and cancelled broker proof cannot issue a session',async()=>{
 const h=await setup();await h.client.exchange(h.token,'s'.repeat(43),'provider-code',h.signal);h.f.revoke();await assert.rejects(h.client.finish(h.token,h.signal));
 const g=await setup();await g.client.cancel(g.token,g.signal);await assert.rejects(g.client.exchange(g.token,'s'.repeat(43),'provider-code',g.signal));
});
test('provider redirect substitutions and malformed responses fail closed',async()=>{
 for(const change of ['origin','nonce','redirect_uri','response_mode','duplicate','extra']){
  const h=await setup();h.mutate(v=>{const u=new URL(v.authorizationUrl);if(change==='origin')u.hostname='foreign.example';else if(change==='duplicate')u.searchParams.append('state','other');else u.searchParams.set(change, 'wrong');return {...v,authorizationUrl:u.href};});
  await assert.rejects(h.client.start(h.token,h.signal),change);
 }
 const h=await setup();h.mutate(()=>({version:1,idToken:42}));await assert.rejects(h.client.exchange(h.token,'s'.repeat(43),'provider-code',h.signal));
 await assert.rejects(h.client.exchange(h.token,'bad','provider-code',h.signal));
 await assert.rejects(h.client.exchange(h.token,'s'.repeat(43),'bad\ncode',h.signal));
 assert.throws(()=>createLinkedOidcProofClient({config:{...h.config,authOrigin:'http://auth.example'},sessions:h.f.sessions}));
});

test('admitted proof commands preserve the original grant through the existing issuer',async()=>{
 const {withTerminalRun}=await import('./terminal-run');
 const binding={run:'original-proof-run',generation:'a'.repeat(64)};
 const request=new Request('https://s3r.ch',{headers:{cookie:'__Host-nightly-run-grant='+'b'.repeat(64)}});
 await withTerminalRun(request,{async admit(){return {binding,operation:'12345678-1234-1234-1234-123456789abc'};},async active(){return true;},async authorizeToken(){return true;},async complete(){}},async()=>{
  const h=await setup(binding),started=await h.client.start(h.token,h.signal);
  await h.client.exchange(h.token,started.state,'provider-code',h.signal);
  const session=await h.client.finish(h.token,h.signal);assert.deepEqual(await h.f.sessions.authenticate(session),{key:h.f.principal});
  await h.client.cancel(h.token,h.signal);assert.deepEqual(h.calls,['start','exchange','result','cancel']);
  return true;
 },result=>result);
});
