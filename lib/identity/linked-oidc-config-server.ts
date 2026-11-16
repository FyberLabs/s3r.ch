import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {deviceConfig} from './device-config';
import {readDevicePerson} from './device-person';
import {configuredLinkedAdmission} from './linked-admission-config-server';
import {configuredIdentityReplay} from './spanopticon-replay-server';
import {identitySessionNamespace} from './replay-namespace';
import {getIdentitySecret} from './secret';
import {createIdentitySessions} from './sea-session';
import {createLinkedOidcProofClient,type LinkedOidcBrokerConfig} from './linked-oidc-proof-server';
import {createLinkedOidcBrowserFlow} from './linked-oidc-browser-flow';
const canonical=(v:unknown):string=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
/** Protected backend-only configuration. Missing configuration performs no IO. */
export async function configuredLinkedOidcFlow(origin:string,env:Record<string,string|undefined>,fetcher:typeof fetch=fetch,clock=()=>Math.floor(Date.now()/1000)){
 const path=env.S3RCH_LINKED_OIDC_CONFIG_FILE;if(path===undefined)return undefined;if(!isAbsolute(path))throw Error('Invalid linked provider configuration');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let raw:string;
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.geteuid?.()||(stat.mode&0o077)||stat.nlink!==1||stat.size>16384)throw Error('Unprotected linked provider configuration');
  const bytes=new Uint8Array(16385);let used=0;for(;;){const {bytesRead}=await file.read(bytes,used,bytes.length-used,null);if(!bytesRead)break;used+=bytesRead;if(used>16384)throw Error('Oversized linked provider configuration');}
  raw=new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,used));
 }finally{await file.close();}
 const config=JSON.parse(raw);
 if(!config||typeof config!=='object'||Array.isArray(config)||canonical(config)+'\n'!==raw||Object.keys(config).sort().join()!=='authOrigin,authorizationEndpoint,clientId,issuer,origin,redirectUri,serviceToken,tenant,version'||config.version!==1||config.origin!==origin||config.redirectUri!==origin+'/api/identity/sea/linked-oidc-callback')throw Error('Invalid linked provider configuration');
 const device=deviceConfig(origin,env);
 if(!device||device.provider.issuer!==config.issuer||device.provider.clientId!==config.clientId||device.provider.authorizationEndpoint!==config.authorizationEndpoint||device.scope.tenant!==config.tenant)throw Error('Unmatched person provider');
 const admission=await configuredLinkedAdmission(origin,env,fetcher,clock),replay=configuredIdentityReplay(identitySessionNamespace(origin),env,fetcher,clock);
 if(!admission||!replay||!admission.supportsOidc(config.issuer,config.tenant,config.clientId))throw Error('Linked identity unavailable');
 const secret=getIdentitySecret({...env,NODE_ENV:'production'}),sessions=createIdentitySessions({origin,secret,clock,consume:replay.consume,challengeDomain:replay.challengeDomain,linkedAdmission:admission});
 const {version,...brokerConfig}=config;
 const broker=createLinkedOidcProofClient({config:brokerConfig as LinkedOidcBrokerConfig,sessions,fetch:fetcher});
 return createLinkedOidcBrowserFlow({origin,providerOrigin:new URL(config.authorizationEndpoint).origin,secret,sessions,broker,clock,
  configDigest:createHash('sha256').update(raw+'\0'+device.digest).digest('hex'),person:async request=>{
   const person=await readDevicePerson(request,device,origin,env,clock());
   return person?.context?{credential:{kind:'oidc',iss:config.issuer,tenant:config.tenant,sub:person.subject},context:person.context,expiresAt:Math.floor(person.expiresAt/1000)}:null;
  }});
}
