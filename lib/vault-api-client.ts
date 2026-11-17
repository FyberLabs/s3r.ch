import { VAULT_API_LIMIT, vaultOperationBytes, type VaultOperation } from './vault-api-contract';
import { readBoundedIdentityJson } from './identity/bounded-json';
import type { VaultHeadTransport } from './vault-storage-client';
function encode(bytes:Uint8Array){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
function decode(value:unknown){
  if(typeof value!=='string'||value.length>VAULT_API_LIMIT)throw Error('Invalid vault response');
  const s=atob(value),bytes=Uint8Array.from(s,c=>c.charCodeAt(0));
  if(!bytes.length||bytes.length>8*1024*1024||encode(bytes)!==value)throw Error('Invalid vault response');return bytes;
}
function tag(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid vault revision');return value;}
/** Supply this to createVaultStorageClient. sign uses local owner custody;
 * cookies gate transport but never replace the owner proof. */
export function createVaultApiTransport(input:{origin:string;owner:string;vaultId:string;sign(bytes:Uint8Array):Promise<string>;fetch?:typeof fetch;clock?:()=>number}):VaultHeadTransport{
  const {origin,owner,vaultId,sign}=input,fetcher=input.fetch??fetch,clock=input.clock??(()=>Math.floor(Date.now()/1000));
  if(new URL(origin).origin!==origin||new URL(origin).protocol!=='https:')throw Error('Invalid vault origin');
  async function call(action:VaultOperation['action'],id:string,data:Uint8Array|undefined,expected:string|null,signal?:AbortSignal){
    const abort=signal?AbortSignal.any([signal,AbortSignal.timeout(120_000)]):AbortSignal.timeout(120_000);
    abort.throwIfAborted();
    const bytes=data===undefined?undefined:new Uint8Array(data);
    if(bytes&&(!bytes.length||bytes.length>8*1024*1024))throw Error('Invalid vault bytes');
    const digest=bytes?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''):null;
    const issuedAt=clock(),op:VaultOperation={v:1,origin,owner,vaultId,action,id,digest,expected,issuedAt,expiresAt:issuedAt+60};
    const sig=await sign(vaultOperationBytes(op));abort.throwIfAborted();
    if(clock()<issuedAt||clock()>=op.expiresAt)throw Error('Expired vault operation');
    const response=await fetcher(origin+'/api/vault',{method:'POST',mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store',signal:abort,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({op,sig,bytes:bytes?encode(bytes):null})});
    if(response.status!==200||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'){
      await response.body?.cancel();throw Error('Vault API unavailable');
    }
    return await readBoundedIdentityJson(response,VAULT_API_LIMIT,abort) as {bytes?:unknown;revision?:unknown;ok?:unknown}|null;
  }
  return Object.freeze({
    async read(id:string,signal?:AbortSignal){const r=await call('read',id,undefined,null,signal);return r===null?null:{bytes:decode(r.bytes),revision:tag(r.revision)};},
    async write(id:string,bytes:Uint8Array,expected:string|null,signal?:AbortSignal){const r=await call('write',id,bytes,expected,signal);return tag(r?.revision);},
    async putObject(id:string,bytes:Uint8Array,signal?:AbortSignal){const r=await call('putObject',id,bytes,null,signal);if(r?.ok!==true)throw Error('Invalid vault response');},
    async getObject(id:string,signal?:AbortSignal){const r=await call('getObject',id,undefined,null,signal);return r===null?null:decode(r.bytes);},
  });
}
