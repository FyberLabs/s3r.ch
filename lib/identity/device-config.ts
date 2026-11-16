import {createHash} from 'node:crypto';
import {findOidcProvider,type OidcProvider} from './providers';
import type {Scope} from 'sea-device-link';
export type DeviceConfig={scope:Scope;auth:string;acl:string;provider:OidcProvider;digest:string};
export function deviceConfig(origin:string,env:Record<string,string|undefined>=process.env):DeviceConfig|null {
 if(!env.S3RCH_DEVICE_TRANSFER_CONFIG)return null;
 try{
  if(env.S3RCH_DEVICE_TRANSFER_CONFIG.length>8192)throw Error();
  const v=JSON.parse(env.S3RCH_DEVICE_TRANSFER_CONFIG);
  if(!v||Object.keys(v).sort().join()!=='acl,auth,provider,scope,v'||v.v!==1||Object.keys(v.scope).sort().join()!=='application,audience,destinationOrigin,sourceOrigin,tenant')throw Error();
  if(!Object.values(v.scope).every(s=>typeof s==='string'&&/^[\x21-\x7e]{1,512}$/.test(s)))throw Error();
  if(new URL(origin).origin!==origin||!origin.startsWith('https://')||v.scope.sourceOrigin!==origin||v.scope.destinationOrigin!==origin||v.scope.application!=='s3r.ch')throw Error();
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.scope.tenant))throw Error();
  for(const key of ['auth','acl']){const u=new URL(v[key]);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.href!==v[key])throw Error();}
  if(!v.auth.endsWith('/auth/sea-device-link/v1/')||!v.acl.endsWith('/api/v1/acl/sociacl/device-transfer/'))throw Error();
  const provider=findOidcProvider(env,v.provider);if(!provider||![provider.issuer,provider.authorizationEndpoint,provider.tokenEndpoint,provider.jwksUri].every(u=>u.startsWith('https://')))throw Error();
  return {scope:v.scope,auth:v.auth,acl:v.acl,provider,digest:createHash('sha256').update(JSON.stringify([v,provider])).digest('hex')};
 }catch{return null;}
}
