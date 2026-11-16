import {createHash} from 'node:crypto';
import {matchesRequestOrigin} from '../request-origin';
import {EncryptJWT,jwtDecrypt} from 'jose';
import {readBoundedIdentityJson} from './bounded-json';
import {terminalTokenClaims,verifyTerminalToken} from './terminal-run';
import {seaSessionCookieNames} from './sea-session-http';
import type {createIdentitySessions} from './sea-session';
import type {createLinkedOidcProofClient} from './linked-oidc-proof-server';
import type {LinkedCredential} from './linked-session-admission';
const pendingName='__Host-s3rch-linked-oidc-attempt',kind='s3rch-linked-oidc-attempt-v1';
const cookie=(value:string,age:number)=>`${pendingName}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${age}`;
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',Vary:'Cookie, Origin'};
const fail=():never=>{throw Error('Linked account attempt unavailable');};
const exact=(v:unknown,names:string):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===names;
export type LinkedOidcPerson=Readonly<{credential:Extract<LinkedCredential,{kind:'oidc'}>;context:string;expiresAt:number}>;
/** One encrypted browser attempt binds the original challenge and provider state.
 * SameSite=None is used only for the provider's form_post callback. Completion
 * additionally requires same-origin POST and the unchanged authenticated person. */
export function createLinkedOidcBrowserFlow(input:{origin:string;providerOrigin:string;configDigest:string;secret:string;
 sessions:ReturnType<typeof createIdentitySessions>;broker:ReturnType<typeof createLinkedOidcProofClient>;
 person:(request:Request)=>Promise<LinkedOidcPerson|null>;clock?:()=>number}){
 const {origin,providerOrigin}=input,clock=input.clock??(()=>Math.floor(Date.now()/1000));
 if(new URL(origin).origin!==origin||!origin.startsWith('https://')||new URL(providerOrigin).origin!==providerOrigin||!providerOrigin.startsWith('https://')||!input.secret||input.secret.length<32||!/^[a-f0-9]{64}$/.test(input.configDigest))return fail();
 const key=createHash('sha256').update('s3r.ch/linked-oidc-attempt/v1\0'+input.secret).digest();
 const reply=(status:number,body:unknown,cookies:string[]=[])=>{const h=new Headers(headers);for(const c of cookies)h.append('Set-Cookie',c);return Response.json(body,{status,headers:h});};
 function supplied(request:Request){const raw=request.headers.get('cookie')??'';if(raw.length>16384)return fail();const matches=raw.split(';').map(v=>v.trim()).filter(v=>v.startsWith(pendingName+'='));if(matches.length>1)return fail();return matches[0]?.slice(pendingName.length+1);}
 async function open(request:Request){
  const raw=supplied(request);if(!raw||raw.length>3800)return fail();
  const {payload}=await jwtDecrypt(raw,key,{issuer:origin,audience:origin,typ:kind,keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM'],currentDate:new Date(clock()*1000),requiredClaims:['iat','exp','sub']});
  if(payload.config!==input.configDigest||typeof payload.challenge!=='string'||typeof payload.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(payload.state)||typeof payload.context!=='string'||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat!>clock()||payload.exp!-payload.iat!>60)return fail();
  await verifyTerminalToken(payload,{kind,subject:payload.sub!});
  const challenge=await input.sessions.linkedProofChallenge(payload.challenge);
  if(challenge.credential.kind!=='oidc'||challenge.credential.sub!==payload.sub||challenge.expiresAt!==payload.exp)return fail();
  return {challenge:payload.challenge,state:payload.state,context:payload.context,credential:challenge.credential,expiresAt:payload.exp!};
 }
 async function person(request:Request,expected?:Awaited<ReturnType<typeof open>>){
  const p=await input.person(request);
  if(!p||p.expiresAt<=clock()||!p.context||request.headers.get('x-device-context')!==p.context||
    (expected&&(p.context!==expected.context||JSON.stringify(p.credential)!==JSON.stringify(expected.credential))))return fail();return p;
 }
 return async(request:Request,action:string):Promise<Response>=>{
  try{
   if(request.method!=='POST'||!matchesRequestOrigin(request,new URL(origin)))return reply(403,{error:'unavailable'});
   const callback=action==='callback';
   if(request.headers.get('origin')!==(callback?providerOrigin:origin))return reply(403,{error:'origin'});
   if(!['start','callback','finish','cancel'].includes(action))return reply(404,{error:'not-found'});
   if(callback){
    if(request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded'||request.headers.get('content-encoding'))return fail();
    let raw='';const reader=request.body?.getReader();if(!reader)return fail();
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(10000)]),cancel=()=>{void reader.cancel().catch(()=>{});};
    signal.addEventListener('abort',cancel,{once:true});
    try{const decoder=new TextDecoder('utf8',{fatal:true});let length=0;for(;;){signal.throwIfAborted();const {value,done}=await reader.read();signal.throwIfAborted();if(done)break;length+=value.length;if(length>16384)return fail();raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
    const q=new URLSearchParams(raw),pending=await open(request);
    if([...q.keys()].some(k=>!['code','state','iss','session_state'].includes(k))||q.size!==new Set(q.keys()).size||q.get('state')!==pending.state||!q.get('code')||(q.has('iss')&&q.get('iss')!==pending.credential.iss))return fail();
    await input.broker.exchange(pending.challenge,pending.state,q.get('code')!,request.signal);
    // Tokens remain at Auth. Same-origin completion reads the saved proof.
    return new Response(null,{status:303,headers:{...headers,Location:origin+'/identity/devices?linked=ready'}});
   }
   if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||request.headers.get('content-encoding'))return fail();
   const body=await readBoundedIdentityJson(new Response(request.body,{headers:{'content-type':'application/json'}}),1024,request.signal);
   if(!exact(body,''))return fail();
   if(action==='start'){
    if(supplied(request))return reply(409,{error:'existing-attempt'});
    const p=await person(request),challenge=await input.sessions.linkedChallenge(p.credential);if(!challenge)return fail();
    const started=await input.broker.start(challenge,request.signal),now=clock();
    if(started.expiresAt<=now||p.expiresAt<started.expiresAt)return fail();
    const current=await person(request);if(current.context!==p.context||JSON.stringify(current.credential)!==JSON.stringify(p.credential))return fail();
    const token=await new EncryptJWT({challenge,state:started.state,context:p.context,config:input.configDigest,...await terminalTokenClaims({kind,subject:p.credential.sub})})
     .setProtectedHeader({alg:'dir',enc:'A256GCM',typ:kind}).setSubject(p.credential.sub).setIssuer(origin).setAudience(origin).setIssuedAt(now).setExpirationTime(started.expiresAt).encrypt(key);
    if(token.length>3800)return fail();request.signal.throwIfAborted();
    return reply(200,{authorizationUrl:started.authorizationUrl},[cookie(token,started.expiresAt-now)]);
   }
   if(action==='cancel'){
    try{const pending=await open(request);await input.broker.cancel(pending.challenge,request.signal);return reply(200,{status:'cancelled'},[cookie('',0)]);}
    catch{return reply(200,{status:'local-cleared-remote-unknown'},[cookie('',0)]);}
   }
   const pending=await open(request);await person(request,pending);
   const session=await input.broker.finish(pending.challenge,request.signal);await person(request,pending);request.signal.throwIfAborted();
   return reply(200,{ok:true},[`${seaSessionCookieNames()[0]}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`,cookie('',0)]);
  }catch{return reply(503,{error:'linked-attempt-unavailable'});}
 };
}
