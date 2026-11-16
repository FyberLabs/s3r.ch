import {terminalRelayHeaders} from './terminal-run';
import {readBoundedIdentityJson} from './bounded-json';
import type {createIdentitySessions} from './sea-session';

type Sessions=ReturnType<typeof createIdentitySessions>;
export type LinkedOidcBrokerConfig=Readonly<{origin:string;authOrigin:string;serviceToken:string;
 issuer:string;tenant:string;clientId:string;authorizationEndpoint:string;redirectUri:string}>;
const fail=():never=>{throw Error('Linked provider proof unavailable');};
const exact=(v:unknown,keys:string):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys;
const https=(value:string)=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash)return fail();return u;};
/** Backend-only Auth69 consumer. It verifies the original issuer challenge before
 * every command. Provider proof stays behind this boundary; only the existing
 * issuer can turn fresh proof and current ACL authorization into a SEA session. */
export function createLinkedOidcProofClient(input:{config:LinkedOidcBrokerConfig;sessions:Sessions;fetch?:typeof fetch}){
 const c=Object.freeze({...input.config}),fetcher=input.fetch??fetch;
 if(!exact(c,'authOrigin,authorizationEndpoint,clientId,issuer,origin,redirectUri,serviceToken,tenant')||
  https(c.origin).origin!==c.origin||https(c.authOrigin).origin!==c.authOrigin||
  !/^[A-Za-z0-9_-]{43,128}$/.test(c.serviceToken)||!c.clientId||c.clientId.length>255||
  https(c.redirectUri).origin!==c.origin||new URL(c.redirectUri).search||
  https(c.authorizationEndpoint).search||https(c.issuer).search)return fail();
 async function original(token:string){
  const proof=await input.sessions.linkedProofChallenge(token);
  if(proof.credential.kind!=='oidc'||proof.credential.iss!==c.issuer||proof.credential.tenant!==c.tenant)return fail();
  return {...proof,origin:c.origin};
 }
 async function command(action:'start'|'exchange'|'result'|'cancel',token:string,signal:AbortSignal,extra:Record<string,string>={}){
  signal.throwIfAborted();const challenge=await original(token);signal.throwIfAborted();
  const target=c.authOrigin+'/auth/linked-oidc/v1/'+action;
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
  const response=await fetcher(target,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:bounded,
   headers:{'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+c.serviceToken,...await terminalRelayHeaders(target)},
   body:JSON.stringify({challenge,...extra})});
  try{
   bounded.throwIfAborted();
   if(response.status!==200||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'||
      ![null,'identity'].includes(response.headers.get('content-encoding')))return fail();
   const value=await readBoundedIdentityJson(response,24576,bounded);bounded.throwIfAborted();
   await original(token);bounded.throwIfAborted();return {value,challenge};
  }finally{if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>{});}
 }
 return Object.freeze({
  async start(token:string,signal:AbortSignal){
   const {value,challenge}=await command('start',token,signal);
   if(!exact(value,'authorizationUrl,version')||value.version!==1||typeof value.authorizationUrl!=='string'||value.authorizationUrl.length>8192)return fail();
   const u=https(value.authorizationUrl),endpoint=new URL(c.authorizationEndpoint),q=u.searchParams;
   if(u.origin!==endpoint.origin||u.pathname!==endpoint.pathname||u.searchParams.size!==new Set(u.searchParams.keys()).size||
      [...q.keys()].sort().join()!=='client_id,code_challenge,code_challenge_method,max_age,nonce,prompt,redirect_uri,response_mode,response_type,scope,state'||
      q.get('client_id')!==c.clientId||q.get('redirect_uri')!==c.redirectUri||q.get('nonce')!==challenge.id||
      q.get('response_type')!=='code'||q.get('response_mode')!=='form_post'||q.get('scope')!=='openid'||
      q.get('prompt')!=='login'||q.get('max_age')!=='0'||q.get('code_challenge_method')!=='S256'||
      !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge')??'')||!/^[A-Za-z0-9_-]{43}$/.test(q.get('state')??''))return fail();
   return {authorizationUrl:u.href,state:q.get('state')!,expiresAt:challenge.expiresAt};
  },
  async exchange(token:string,state:string,code:string,signal:AbortSignal){
   if(!/^[A-Za-z0-9_-]{43}$/.test(state)||typeof code!=='string'||!code.length||code.length>4096||/[\x00-\x1f\x7f]/.test(code))return fail();
   const {value}=await command('exchange',token,signal,{state,code});
   if(!exact(value,'idToken,version')||value.version!==1||typeof value.idToken!=='string'||value.idToken.length>16384)return fail();
   // The durable broker owns proof readback. No provider token leaves this method.
  },
  async finish(token:string,signal:AbortSignal){
   const {value}=await command('result',token,signal);
   if(!exact(value,'idToken,version')||value.version!==1||typeof value.idToken!=='string'||value.idToken.length>16384)return fail();
   signal.throwIfAborted();const session=await input.sessions.exchangeLinked(token,{idToken:value.idToken});
   signal.throwIfAborted();if(!session)return fail();return session;
  },
  async cancel(token:string,signal:AbortSignal){
   const {value}=await command('cancel',token,signal);
   if(!exact(value,'status,version')||value.version!==1||value.status!=='cancelled')return fail();
  }
 });
}
