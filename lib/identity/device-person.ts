import {terminalTokenClaims,verifyTerminalToken} from "./terminal-run";
import {createHash,randomBytes} from 'node:crypto';
import {EncryptJWT,jwtDecrypt,jwtVerify,createRemoteJWKSet,type JWTVerifyGetKey} from 'jose';
import {createPkcePair,exchangeCode} from './oauth';
import {readCookie,serializeCookie,cookieOptions} from './cookies';
import {getIdentitySecret} from './secret';
import {devicePersonCookie,devicePendingCookie} from './device-cookies';
import type {DeviceConfig} from './device-config';
const ttl=300;
const key=(env:Record<string,string|undefined>)=>createHash('sha256').update('s3r.ch/device-person/v1\0'+getIdentitySecret({...env,NODE_ENV:'production'})).digest();
const clear=(name:string)=>serializeCookie(name,'',cookieOptions(true,0));
export const personClearCookies=()=>[clear(devicePersonCookie),clear(devicePendingCookie)];
async function seal(payload:Record<string,unknown>,kind:string,origin:string,env:Record<string,string|undefined>,now:number,exp=now+ttl){
 return new EncryptJWT({...payload,...await terminalTokenClaims({kind,subject:typeof payload.sub==='string'?payload.sub:null})}).setProtectedHeader({alg:'dir',enc:'A256GCM',typ:kind}).setIssuer(origin).setAudience(origin).setIssuedAt(now).setExpirationTime(exp).encrypt(key(env));
}
async function open(request:Request,name:string,kind:string,config:DeviceConfig,origin:string,env:Record<string,string|undefined>,now:number){
 const token=readCookie(request.headers.get('cookie'),[name]);if(!token||token.length>3800)throw Error();
 const {payload}=await jwtDecrypt(token,key(env),{issuer:origin,audience:origin,currentDate:new Date(now*1000),keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM'],typ:kind,requiredClaims:['iat','exp']});
 if(!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat!>now||payload.exp!-payload.iat!>ttl||payload.config!==config.digest)throw Error();
 await verifyTerminalToken(payload,{kind,subject:typeof payload.sub==='string'?payload.sub:null});
 return payload;
}
export async function readDevicePerson(request:Request,config:DeviceConfig,origin:string,env:Record<string,string|undefined>,now=Math.floor(Date.now()/1000)){
 try{const p=await open(request,devicePersonCookie,'s3rch-device-person-v1',config,origin,env,now);
  if(typeof p.access!=='string'||!/^[\x21-\x7e]{1,3000}$/.test(p.access)||typeof p.sub!=='string'||p.sub.length>255)return null;
  return {access:p.access,subject:p.sub,context:typeof p.context==='string'?p.context:null,expiresAt:p.exp!*1000};
 }catch{return null;}
}
function redirect(location:string,cookies:string[]){const headers=new Headers({Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});for(const c of cookies)headers.append('Set-Cookie',c);return new Response(null,{status:302,headers});}
export async function devicePersonOAuth(request:Request,action:'authorize'|'callback',config:DeviceConfig,origin:string,env:Record<string,string|undefined>,deps:{fetch?:typeof fetch;verifyKey?:JWTVerifyGetKey|Uint8Array;now?:()=>number}={}){
 const now=(deps.now??(()=>Math.floor(Date.now()/1000)))(),callback=origin+'/api/identity/device/callback',provider=config.provider;
 try{
  if(action==='authorize'){
   const {verifier,challenge}=createPkcePair(),state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
   const token=await seal({verifier,state,nonce,config:config.digest},'s3rch-device-pkce-v1',origin,env,now);
   const url=new URL(provider.authorizationEndpoint);
   for(const [k,v] of Object.entries({client_id:provider.clientId,redirect_uri:callback,response_type:'code',scope:'openid auth:device:transfer acl:identity:transfer',state,nonce,code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(k,v);
   return redirect(url.href,[...personClearCookies(),serializeCookie(devicePendingCookie,token,cookieOptions(true,ttl))]);
  }
  const p=await open(request,devicePendingCookie,'s3rch-device-pkce-v1',config,origin,env,now),q=new URL(request.url).searchParams;
  if(q.has('error')||!q.get('code')||q.get('code')!.length>2048||q.get('state')!==p.state||typeof p.verifier!=='string'||typeof p.nonce!=='string')throw Error();
  const exchanged=await exchangeCode({issuer:provider.issuer,clientId:provider.clientId,tokenEndpoint:provider.tokenEndpoint,code:q.get('code')!,verifier:p.verifier,redirectUri:callback},deps.fetch);
  const {payload}=await jwtVerify(exchanged.idToken,deps.verifyKey??createRemoteJWKSet(new URL(provider.jwksUri)),{issuer:provider.issuer,audience:provider.clientId,algorithms:['RS256','PS256','ES256'],currentDate:new Date(now*1000),requiredClaims:['sub','iat','exp','nonce']});
  if(payload.nonce!==p.nonce||typeof payload.sub!=='string'||payload.sub.length>255||!Number.isSafeInteger(payload.iat)||payload.iat!>now||!Number.isSafeInteger(payload.exp)||(payload.azp!==undefined&&payload.azp!==provider.clientId)||!exchanged.accessToken)throw Error();
  await verifyTerminalToken(payload,{kind:'provider-id-token',subject:payload.sub});
  const finished=(deps.now??(()=>Math.floor(Date.now()/1000)))();if(p.exp!<=finished||payload.exp!<=finished)throw Error();
  const token=await seal({access:exchanged.accessToken,sub:payload.sub,context:randomBytes(32).toString('base64url'),config:config.digest},'s3rch-device-person-v1',origin,env,finished,Math.min(finished+ttl,payload.exp!));
  if(token.length>3800)throw Error();
  return redirect('/identity/devices',[clear(devicePendingCookie),serializeCookie(devicePersonCookie,token,cookieOptions(true,Math.min(ttl,payload.exp!-finished)))]);
 }catch{return redirect('/identity/devices?authorization=unavailable',personClearCookies());}
}
