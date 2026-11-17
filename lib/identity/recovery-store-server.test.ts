// Cookie crypto and transport contracts execute in CI only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {EncryptJWT} from 'jose';
import {deviceConfig} from './device-config';
import {deviceServer} from './device-server';
import {devicePersonCookie} from './device-cookies';
const origin='https://s3r.ch',context='recovery-owner-context';
const scope={sourceOrigin:origin,destinationOrigin:origin,application:'s3r.ch',tenant:'11111111-1111-1111-1111-111111111111',audience:'device'};
const env={IDENTITY_SESSION_SECRET:'x'.repeat(40),S3RCH_RECOVERY_STORE_ENABLED:'true',S3RCH_OAUTH_ISSUER:'https://issuer.example/realm',S3RCH_DEVICE_TRANSFER_CONFIG:JSON.stringify({v:1,scope,auth:'https://auth.example/auth/sea-device-link/v1/',acl:'https://acl.example/api/v1/acl/sociacl/device-transfer/',provider:'panopticon'})};
const p='axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const row={principal:p,signingPub:p,epub:p,rotationSeq:0,bytesHex:'01'+'00'.repeat(60)};
async function fixture(){
 const now=Math.floor(Date.now()/1000),config=deviceConfig(origin,env)!;
 const key=createHash('sha256').update('s3r.ch/device-person/v1\0'+env.IDENTITY_SESSION_SECRET).digest();
 const token=await new EncryptJWT({config:config.digest,access:'person-bearer',sub:'person',context}).setProtectedHeader({alg:'dir',enc:'A256GCM',typ:'s3rch-device-person-v1'}).setIssuer(origin).setAudience(origin).setIssuedAt(now).setExpirationTime(now+300).encrypt(key);
 return (body:any,headers:Record<string,string>={})=>new Request(origin+'/api/identity/device/recovery-read',{method:'POST',headers:{origin,'content-type':'application/json','x-device-context':context,cookie:devicePersonCookie+'='+token,...headers},body:JSON.stringify(body)});
}
test('recovery forwards only the authenticated person and fixed owner route',async()=>{
 const req=await fixture();let calls=0;
 const result=await deviceServer(req({slot:'current'}),'recovery-read',env,async(url,init)=>{
  calls++;assert.equal(String(url),'https://acl.example/api/v1/acl/sociacl/keyring/recovery/rows/current');assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);
  const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer person-bearer');assert.equal(headers.get('x-tenant-id'),scope.tenant);assert.equal(headers.has('cookie'),false);
  assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');return Response.json({generation:0,head:{sequence:0,currentKey:p,currentEpub:p,diagnostics:[]},row:null});
 });
 assert.equal(result.status,200);assert.equal(calls,1);assert.match(result.headers.get('cache-control')!,/no-store/);assert.deepEqual((await result.json()).head,{sequence:0,currentKey:p,currentEpub:p});
 const operation={action:'put',row,signature:'00'.repeat(64)};
 const written=await deviceServer(req(operation),'recovery-put',env,async(url,init)=>{
  assert.equal(String(url),'https://acl.example/api/v1/acl/sociacl/keyring/recovery/operations');assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),operation);return Response.json({generation:1});
 });assert.equal(written.status,200);
});
test('recovery stays off without explicit config and refuses foreign contexts/private inputs',async()=>{
 const req=await fixture();let calls=0;const never=async()=>{calls++;throw Error();};
 assert.equal((await deviceServer(req({slot:'current'}),'recovery-read',{...env,S3RCH_RECOVERY_STORE_ENABLED:undefined},never)).status,503);
 for(const headers of [{'x-device-context':'wrong'},{cookie:''},{origin:'https://foreign.example'}] as Record<string,string>[])assert.ok([401,403].includes((await deviceServer(req({slot:'current'},headers),'recovery-read',env,never)).status));
 for(const body of [{slot:'../wraps'},{slot:'current',principal:p},{passphrase:'secret'}])assert.equal((await deviceServer(req(body),'recovery-read',env,never)).status,503);
 assert.equal((await deviceServer(req({action:'put',row:{...row,priv:'secret'},signature:'00'.repeat(64)}),'recovery-put',env,never)).status,503);assert.equal(calls,0);
});
test('recovery never retries failed writes and refuses malformed owner replies',async()=>{
 const req=await fixture(),operation={action:'put',row,signature:'00'.repeat(64)};let calls=0;
 const conflict=await deviceServer(req(operation),'recovery-put',env,async()=>{calls++;return Response.json({secret:'private'},{status:409});});assert.equal(conflict.status,409);assert.equal(calls,1);assert.equal((await conflict.text()).includes('private'),false);
 for(const result of [{generation:1,secret:'private'},{generation:-1},{}])assert.equal((await deviceServer(req(operation),'recovery-put',env,async()=>Response.json(result))).status,503);
 assert.equal((await deviceServer(req({slot:'current'}),'recovery-read',env,async()=>Response.json({generation:1,head:{sequence:0,currentKey:p,currentEpub:p},row:{...row,priv:'secret'}}))).status,503);
});

test('rotation witness, publication, exact state and recovery commit use fixed authenticated routes',async()=>{
 const vectors=(await import('./vectors/forum-rotation-record.json')).default;
 const record:any=vectors.accept.find((row:any)=>row.input.nextEpub&&row.input.authorizer.kind==='wallet')!.input;
 const {attest,...request}=record;
 const req=await fixture(),enabled={...env,S3RCH_RECOVERY_ROTATION_ENABLED:'true'};
 const head={sequence:record.seq,currentKey:record.nextKey,currentEpub:record.nextEpub};
 for(const [action,input,path,result] of [
  ['rotation-witness',request,'rotation/wallet',{attest}],
  ['rotation-publish',record,'rotation/wallet/publish',{recordHash:'ab'.repeat(32)}],
  ['rotation-state',{record},'rotation/wallet/state',{recordHash:'ab'.repeat(32),present:true,head}],
  ['recovery-commit',{action:'commit',signature:'00'.repeat(64)},'keyring/recovery/operations',{generation:2}],
 ] as const){
  const response=await deviceServer(req(input),action,enabled,async(url,init)=>{
   assert.equal(String(url),'https://acl.example/api/v1/acl/sociacl/'+path);
   assert.equal(new Headers(init?.headers).get('authorization'),'Bearer person-bearer');
   assert.equal(new Headers(init?.headers).get('x-tenant-id'),scope.tenant);
   assert.deepEqual(JSON.parse(String(init?.body)),input);return Response.json(result);
  });assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
  let calls=0;const never=async()=>{calls++;throw Error();};
  assert.equal((await deviceServer(req(input),action,env,never)).status,503);
  assert.equal((await deviceServer(req({...input,priv:'secret'}),action,enabled,never)).status,503);
  assert.equal((await deviceServer(req(input,{'x-device-context':'foreign'}),action,enabled,never)).status,401);
  assert.equal(calls,0);
  assert.equal((await deviceServer(req(input),action,enabled,async()=>Response.json({...result,priv:'private'}))).status,503);
  const failed=await deviceServer(req(input),action,enabled,async()=>{calls++;return Response.json({private:'detail'},{status:409});});
  assert.equal(failed.status,409);assert.equal(calls,1);assert.equal((await failed.text()).includes('detail'),false);
 }
});

test('maximum retained rotations pass bounded transport and private proof objects never leave it',async()=>{
 const vectors=(await import('./vectors/forum-rotation-record.json')).default;
 const original:any=vectors.accept.find((row:any)=>row.input.nextEpub&&row.input.authorizer.kind==='wallet')!.input;
 const retainedLinks=Array.from(new Set([original.authorizer.link,...Array.from({length:1024},(_,i)=>i.toString(16).padStart(64,'0'))])).slice(0,1024).sort();
 const record={...original,retainedLinks}, {attest,...request}=record;
 const req=await fixture(),enabled={...env,S3RCH_RECOVERY_ROTATION_ENABLED:'true'};
 const head={sequence:record.seq,currentKey:record.nextKey,currentEpub:record.nextEpub};
 for(const [action,input,result] of [
  ['rotation-witness',request,{attest}],
  ['rotation-publish',record,{recordHash:'ab'.repeat(32)}],
  ['rotation-state',{record},{recordHash:'ab'.repeat(32),present:true,head}],
 ] as const){
  assert.ok(Buffer.byteLength(JSON.stringify(input))>65536);
  let calls=0;
  const response=await deviceServer(req(input),action,enabled,async(_url,init)=>{
   calls++;assert.deepEqual(JSON.parse(String(init?.body)),input);return Response.json(result);
  });
  assert.equal(response.status,200);assert.equal(calls,1);
  calls=0;
  assert.equal((await deviceServer(req({...input,extra:'x'.repeat(256*1024)}),action,enabled,async()=>{calls++;throw Error();})).status,503);
  assert.equal(calls,0);
 }
 for(const field of ['message','signature']){
  let calls=0;
  const bad={...request,authorizer:{...request.authorizer,siwe:{...request.authorizer.siwe,[field]:{priv:'secret'}}}};
  assert.equal((await deviceServer(req(bad),'rotation-witness',enabled,async()=>{calls++;throw Error();})).status,503);
  assert.equal(calls,0);
 }
});
