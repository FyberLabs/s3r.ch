import {walletRotation,rotationAttestation,rotationPublished,rotationState,recoveryCommit} from './recovery-rotation-protocol';
import {recoveryPut,recoveryView,recoveryGeneration,recoveryResponseLimit} from './recovery-store-protocol';
import {terminalRelayHeaders,terminalAclHeaders} from "./terminal-run";
import {exact,sameScope,publicIdentity,publicBinding,publicRelayPayload} from './device-public';
import {requestHost,requestIsSecure,matchesRequestOrigin} from '../request-origin';
import {deviceConfig} from './device-config';
import {readDevicePerson,devicePersonOAuth,personClearCookies} from './device-person';
import {readBoundedIdentityJson} from './bounded-json';
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',Vary:'Cookie, Origin'};
const reply=(status:number,value:unknown)=>Response.json(value,{status,headers});
async function body(request:Request,maximum=710000){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||request.headers.get('content-encoding'))throw Error();
 return readBoundedIdentityJson(new Response(request.body,{headers:{'content-type':'application/json'}}),maximum,request.signal);
}
export async function deviceServer(request:Request,action:string,env:Record<string,string|undefined>=process.env,fetcher:typeof fetch=fetch){
 try{
  if(!requestIsSecure(request))return reply(403,{error:'unavailable'});
  const origin='https://'+requestHost(request),config=deviceConfig(origin,env);if(!matchesRequestOrigin(request,new URL(origin)))return reply(403,{error:'unavailable'});if(!config)return reply(503,{error:'unavailable'});
  if(request.method==='GET'&&(action==='authorize'||action==='callback'))return devicePersonOAuth(request,action,config,origin,env,{fetch:fetcher});
  if(request.method==='POST'&&request.headers.get('origin')!==origin)return reply(403,{error:'unavailable'});
  if(action==='logout'&&request.method==='POST'){const r=reply(200,{ok:true});for(const c of personClearCookies())r.headers.append('Set-Cookie',c);return r;}
  const person=await readDevicePerson(request,config,origin,env);
  if(request.method==='GET'&&action==='config')return reply(200,{scope:config.scope,authorized:!!person,linkedOidcEnabled:!!env.S3RCH_LINKED_OIDC_CONFIG_FILE,recoveryStoreEnabled:env.S3RCH_RECOVERY_STORE_ENABLED==='true',recoveryRotationEnabled:env.S3RCH_RECOVERY_ROTATION_ENABLED==='true',subject:person?.subject??null,context:person?.context??null,expiresAt:person?.expiresAt??null});
  if(request.method!=='POST'||!['relay','state','current','recovery-read','recovery-put','recovery-commit','rotation-witness','rotation-publish','rotation-state'].includes(action))return reply(404,{error:'unavailable'});
  if(!person||!person.context||request.headers.get('x-device-context')!==person.context)return reply(401,{error:'authorization-required'});
  const recovery=['recovery-read','recovery-put','recovery-commit'].includes(action);
  const rotation=['rotation-witness','rotation-publish','rotation-state'].includes(action);
  if((rotation||action==='recovery-commit')&&env.S3RCH_RECOVERY_ROTATION_ENABLED!=='true')return reply(503,{error:'unavailable'});
  if(recovery&&env.S3RCH_RECOVERY_STORE_ENABLED!=='true')return reply(503,{error:'unavailable'});
  const value:any=await body(request,action==='recovery-put'?recoveryResponseLimit:rotation?256*1024:710000);let target:string,upstream:unknown,limit:number,method='POST';const outgoing:Record<string,string>={'Content-Type':'application/json',Accept:'application/json',Origin:origin};
  if(recovery){
   outgoing.Authorization='Bearer '+person.access;outgoing['X-Tenant-ID']=config.scope.tenant;limit=recoveryResponseLimit;
   const root=new URL('../keyring/recovery/',config.acl).href;
   if(action==='recovery-read'){
    if(!exact(value,'slot')||!['current','pending'].includes(value.slot))throw Error();
    target=root+'rows/'+value.slot;upstream=undefined;method='GET';
   }else{
    if(!(action==='recovery-commit'?recoveryCommit(value):recoveryPut(value)))throw Error();
    target=root+'operations';upstream=value;
   }
  }else if(rotation){
   outgoing.Authorization='Bearer '+person.access;outgoing['X-Tenant-ID']=config.scope.tenant;limit=256*1024;
   if(action==='rotation-state'?!exact(value,'record')||!walletRotation(value.record,true):!walletRotation(value,action==='rotation-publish'))throw Error();
   const root=new URL('../rotation/wallet',config.acl).href;
   target=root+(action==='rotation-publish'?'/publish':action==='rotation-state'?'/state':'');upstream=value;
  }else if(action==='relay'){
   if(!exact(value,'session action scope payload headers')||!/^[A-Za-z0-9_-]{43}$/.test(value.session)||!['admit','create','join','offer','send','receive','complete','completed','cancel'].includes(value.action)||!sameScope(value.scope,config.scope)||!publicRelayPayload(value.action,value.payload,config.scope,value.session))throw Error();
   if(!value.headers||!['receiver','sender'].includes(value.headers['X-Pairing-Role'])||Object.keys(value.headers).some(k=>!['X-Pairing-Role','X-Pairing-Capability','X-Pairing-Join'].includes(k)))throw Error();
   for(const k of ['X-Pairing-Capability',...(value.action==='join'?['X-Pairing-Join']:[])])if(typeof value.headers[k]!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.headers[k]))throw Error();
   if(value.headers['X-Pairing-Role']==='sender'){if(!person)return reply(401,{error:'authorization-required'});outgoing.Authorization='Bearer '+person.access;}
   Object.assign(outgoing,value.headers);target=config.auth+'sessions/'+value.session+'/'+value.action;upstream={scope:config.scope,payload:value.payload};limit=710000;
  }else{
   if(!person)return reply(401,{error:'authorization-required'});
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
   if(action==='state'?!exact(value,'scope identity'):!(exact(value,'binding')||exact(value,'binding expectedRevision')))throw Error();
   if(action==='state'?(!sameScope(value.scope,config.scope)||!publicIdentity(value.identity)):(!publicBinding(value.binding,config.scope)||(value.expectedRevision!==undefined&&(typeof value.expectedRevision!=='string'||value.expectedRevision.length>512))))throw Error();
   outgoing.Authorization='Bearer '+person.access;outgoing['X-Tenant-ID']=config.scope.tenant;target=config.acl+action;upstream=value;limit=4*1024*1024;
  }
  Object.assign(outgoing,await (action==='relay'?terminalRelayHeaders(target):terminalAclHeaders(target)));
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(10000)]);
  const response=await fetcher(target,{method,headers:outgoing,body:upstream===undefined?undefined:JSON.stringify(upstream),credentials:'omit',redirect:'error',cache:'no-store',signal});
  if(response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'){await response.body?.cancel();throw Error();}
  if(!response.ok){await response.body?.cancel();return reply([400,401,403,404,409,410,413,429,503].includes(response.status)?response.status:503,{error:'unavailable'});}
  const result=await readBoundedIdentityJson(response,limit,signal);
  if(rotation&&!(action==='rotation-witness'?rotationAttestation(result):action==='rotation-publish'?rotationPublished(result):rotationState(result)))throw Error();
  if(recovery&&!(action==='recovery-read'?recoveryView(result):recoveryGeneration(result)))throw Error();
  if(action==='recovery-read'){const view=result as {generation:number;head:{sequence:number;currentKey:string;currentEpub:string|null};row:unknown};return reply(200,{generation:view.generation,head:{sequence:view.head.sequence,currentKey:view.head.currentKey,currentEpub:view.head.currentEpub},row:view.row});}
  return reply(200,result);
 }catch{return reply(503,{error:'unavailable'});}
}
