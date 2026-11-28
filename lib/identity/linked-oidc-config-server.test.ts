// Protected configuration, encrypted person context and route contracts: CI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {EncryptJWT} from 'jose';
import {configuredLinkedOidcFlow} from './linked-oidc-config-server';
import {siteSeaSession} from './site-sea-session-server';
import {deviceConfig} from './device-config';
import {devicePersonCookie} from './device-cookies';
import {setup,f} from './fixtures/agent-delegation';
const canonical=(v:unknown)=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)+'\n';
test('unconfigured broker routes remain unavailable without outbound IO',async()=>{
 const fetcher:typeof fetch=async()=>{assert.fail('no IO');};
 assert.equal(await configuredLinkedOidcFlow('https://s3r.ch',{},fetcher),undefined);
 assert.equal(await configuredLinkedOidcFlow('https://s3r.ch',{S3RCH_SERVICE_CREDENTIAL:'private-replay-key'},fetcher),undefined);
 const sessionOnly=new Request('https://s3r.ch/api/identity/sea/session');
 assert.deepEqual(await (await siteSeaSession(sessionOnly,'session',{S3RCH_SERVICE_CREDENTIAL:'private-replay-key'},fetcher)).json(),{enabled:false,principal:null});
 for(const action of ['start','callback','finish','cancel']){
  const response=await siteSeaSession(new Request('https://s3r.ch/api/identity/sea/linked-oidc-'+action,{method:'POST'}),'linked-oidc-'+action,{},fetcher);
  assert.equal(response.status,503);
 }
 await assert.rejects(configuredLinkedOidcFlow('https://s3r.ch',{S3RCH_LINKED_OIDC_CONFIG_FILE:'relative'}));
});
test('protected config binds the existing person provider and keeps service credentials server-side',async()=>{
 const h=await setup(),root=await mkdtemp(join(tmpdir(),'linked-oidc-config-')),path=join(root,'broker.json'),identityPath=join(root,'identity.json');
 const origin='https://s3r.ch',issuer=h.oidc.cred.iss,tenant=h.oidc.cred.tenant;
 const config={version:1,origin,authOrigin:'https://auth.example',serviceToken:'a'.repeat(43),issuer,tenant,clientId:'site',authorizationEndpoint:issuer+'/protocol/openid-connect/auth',redirectUri:origin+'/api/identity/sea/linked-oidc-callback'};
 const identity={version:1,origin,source:{origin:'https://acl.example',tenant,source:'01234567-89ab-cdef-0123-456789abcdee',apiKey:'private-unit-key'},trust:{...h.trust,pinnedIss:[...h.trust.pinnedIss]},walletChainIds:[],oidc:[{issuer,tenant,clientId:'site',tenantClaim:'tenant_id',jwks:h.trust.jwks}]};
 const scope={sourceOrigin:origin,destinationOrigin:origin,application:'s3r.ch',tenant,audience:'device'};
 const env={S3RCH_SESSION_SIGNING_KEY:'x'.repeat(40),S3RCH_OAUTH_ISSUER:issuer,S3RCH_OAUTH_CLIENT_ID:'site',S3RCH_DEVICE_TRANSFER_CONFIG:JSON.stringify({v:1,scope,auth:'https://auth.example/auth/sea-device-link/v1/',acl:'https://acl.example/api/v1/acl/sociacl/device-transfer/',provider:'panopticon'}),S3RCH_LINKED_OIDC_CONFIG_FILE:path,S3RCH_LINKED_IDENTITY_CONFIG_FILE:identityPath,S3RCH_IDENTITY_REPLAY_BACKEND:'spanopticon',S3RCH_IDENTITY_REPLAY_ORIGIN:'https://storage.example',S3RCH_IDENTITY_REPLAY_TENANT_ID:tenant,S3RCH_SERVICE_CREDENTIAL:'private-replay-key'};
 let calls=0;
 const fetcher:typeof fetch=async(url,options)=>{calls++;assert.equal(String(url),config.authOrigin+'/auth/linked-oidc/v1/start');assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+config.serviceToken);const {challenge}=JSON.parse(String(options?.body));assert.equal(challenge.credential.sub,'existing-person');const u=new URL(config.authorizationEndpoint);for(const [k,v] of Object.entries({client_id:'site',redirect_uri:config.redirectUri,response_type:'code',response_mode:'form_post',scope:'openid',nonce:challenge.id,state:'s'.repeat(43),code_challenge:'p'.repeat(43),code_challenge_method:'S256',prompt:'login',max_age:'0'}))u.searchParams.set(k,v);return Response.json({version:1,authorizationUrl:u.href});};
 try{
  await writeFile(path,canonical(config),{mode:0o600});await writeFile(identityPath,canonical(identity),{mode:0o600});
  const flow=await configuredLinkedOidcFlow(origin,env,fetcher,()=>f.now);assert.ok(flow);
  const device=deviceConfig(origin,env)!,context='person-context',key=createHash('sha256').update('s3r.ch/device-person/v1\0'+env.S3RCH_SESSION_SIGNING_KEY).digest();
  const person=await new EncryptJWT({config:device.digest,access:'person-bearer',sub:'existing-person',context}).setProtectedHeader({alg:'dir',enc:'A256GCM',typ:'s3rch-device-person-v1'}).setIssuer(origin).setAudience(origin).setIssuedAt(f.now).setExpirationTime(f.now+300).encrypt(key);
  const response=await siteSeaSession(new Request(origin+'/api/identity/sea/linked-oidc-start',{method:'POST',headers:{origin,'content-type':'application/json','x-device-context':context,cookie:devicePersonCookie+'='+person},body:'{}'}),'linked-oidc-start',env,fetcher,()=>f.now);assert.equal(response.status,200);assert.equal(calls,1);assert.ok(!(await response.text()).includes(config.serviceToken));assert.match(response.headers.getSetCookie()[0],/HttpOnly; SameSite=None/);
  await chmod(path,0o644);await assert.rejects(configuredLinkedOidcFlow(origin,env));await chmod(path,0o600);
  const alias=join(root,'alias');await symlink(path,alias);await assert.rejects(configuredLinkedOidcFlow(origin,{...env,S3RCH_LINKED_OIDC_CONFIG_FILE:alias}));
  for(const value of [{...config,origin:'https://foreign.example'},{...config,clientId:'foreign'},{...config,redirectUri:origin+'/foreign'}]){await writeFile(path,canonical(value));await assert.rejects(configuredLinkedOidcFlow(origin,env));}
  await writeFile(path,canonical(config));await assert.rejects(configuredLinkedOidcFlow(origin,{...env,S3RCH_IDENTITY_REPLAY_BACKEND:undefined}));
  await writeFile(path,'{"version":1,"version":1}\n');await assert.rejects(configuredLinkedOidcFlow(origin,env));
 }finally{await rm(root,{recursive:true,force:true});}
});
