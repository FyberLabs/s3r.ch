import {terminalRelayHeaders} from "./terminal-run";
import {exact,sameScope,publicIdentity,publicBinding,publicRelayPayload} from './device-public';
import {requestHost,requestIsSecure,matchesRequestOrigin} from '../request-origin';
import {deviceConfig} from './device-config';
import {readDevicePerson,devicePersonOAuth,personClearCookies} from './device-person';
import {readBoundedIdentityJson} from './bounded-json';
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',Vary:'Cookie, Origin'};
const reply=(status:number,value:unknown)=>Response.json(value,{status,headers});
async function body(request:Request){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||request.headers.get('content-encoding'))throw Error();
 return readBoundedIdentityJson(new Response(request.body,{headers:{'content-type':'application/json'}}),710000,request.signal);
}
export async function deviceServer(request:Request,action:string,env:Record<string,string|undefined>=process.env,fetcher:typeof fetch=fetch){
 try{
  if(!requestIsSecure(request))return reply(403,{error:'unavailable'});
  const origin='https://'+requestHost(request),config=deviceConfig(origin,env);if(!matchesRequestOrigin(request,new URL(origin)))return reply(403,{error:'unavailable'});if(!config)return reply(503,{error:'unavailable'});
  if(request.method==='GET'&&(action==='authorize'||action==='callback'))return devicePersonOAuth(request,action,config,origin,env,{fetch:fetcher});
  if(request.method==='POST'&&request.headers.get('origin')!==origin)return reply(403,{error:'unavailable'});
  if(action==='logout'&&request.method==='POST'){const r=reply(200,{ok:true});for(const c of personClearCookies())r.headers.append('Set-Cookie',c);return r;}
  const person=await readDevicePerson(request,config,origin,env);
  if(request.method==='GET'&&action==='config')return reply(200,{scope:config.scope,authorized:!!person,subject:person?.subject??null,context:person?.context??null,expiresAt:person?.expiresAt??null});
  if(request.method!=='POST'||!['relay','state','current'].includes(action))return reply(404,{error:'unavailable'});
  if(!person||!person.context||request.headers.get('x-device-context')!==person.context)return reply(401,{error:'authorization-required'});
  const value:any=await body(request);let target:string,upstream:unknown,limit:number;const outgoing:Record<string,string>={'Content-Type':'application/json',Accept:'application/json',Origin:origin};
  if(action==='relay'){
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
  if(action==='relay')Object.assign(outgoing,await terminalRelayHeaders(target));
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(10000)]);
  const response=await fetcher(target,{method:'POST',headers:outgoing,body:JSON.stringify(upstream),credentials:'omit',redirect:'error',cache:'no-store',signal});
  if(response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'){await response.body?.cancel();throw Error();}
  if(!response.ok){await response.body?.cancel();return reply([400,401,403,404,409,410,413,429,503].includes(response.status)?response.status:503,{error:'unavailable'});}
  return reply(200,await readBoundedIdentityJson(response,limit,signal));
 }catch{return reply(503,{error:'unavailable'});}
}
