import {lengthPrefixed,signWithKeyring,parsePrincipalId} from 'sociacl-ids';
import type {SeaPair} from './identity/sea';
import {readBoundedIdentityJson} from './identity/bounded-json';
import {parseContactResult,CONTACT_RESPONSE_LIMIT,type ContactAction,type ContactConfiguration,type ContactDocument,type ContactKind} from './contact-document';
const fail=():never=>{throw Error('Contact session unavailable');};
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export async function contactDigest(bytes:Uint8Array){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))));}
export function contactBytes(value:string):Uint8Array{
  if(typeof value!=='string'||value.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return fail();
  const raw=atob(value);if(btoa(raw)!==value)return fail();return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
export function contactBase64(bytes:Uint8Array){let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(raw);}

/** Current identity is checked around every await. The API key stays server-side.
 * A prepared CAS retains ciphertext; ambiguous writes reconcile before signing
 * again. It never overwrites an intervening contact/block update. */
export async function openContactDocuments(pair:SeaPair,current:()=>boolean,signal:AbortSignal,
  fetcher:typeof fetch=fetch,clock=()=>Math.floor(Date.now()/1000)){
  const held={...pair};let configuration:ContactConfiguration;
  const guard=(signal:AbortSignal)=>{signal.throwIfAborted();if(!current())return fail();};
  async function request(action:ContactAction,body:Record<string,unknown>,signal:AbortSignal){
    guard(signal);const response=await fetcher('/api/contacts/'+action,{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    guard(signal);
    if(response.status!==200||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'){await response.body?.cancel();return fail();}
    const raw=await readBoundedIdentityJson(response,CONTACT_RESPONSE_LIMIT,signal);guard(signal);
    const reader=configuration?.principal??(raw as ContactConfiguration)?.principal;
    const parsed=parseContactResult(action,raw,body,reader,clock());guard(signal);return parsed;
  }
  configuration=await request('config',{evaluatedAt:clock()},signal) as ContactConfiguration;
  if(configuration.currentKey!==held.pub)return fail();
  const owner=parsePrincipalId(configuration.principal),writer=parsePrincipalId(held.pub);if(!owner.ok||!writer.ok)return fail();
  async function read(principal:string,kind:ContactKind,signal:AbortSignal){
    const result=await request('read',{owner:principal,kind,evaluatedAt:clock()},signal) as ContactDocument;
    if(principal===configuration.principal&&result.head.currentKey!==held.pub)return fail();
    return result;
  }
  return Object.freeze({configuration:structuredClone(configuration),read,
    async prepare(kind:ContactKind,revision:number,payload:Uint8Array,signal:AbortSignal,fence?:string){
      guard(signal);if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER||!(payload instanceof Uint8Array)||
        payload.length<(kind==='vault'?28:1)||payload.length>(kind==='vault'?1048576:8192))return fail();
      const bytes=new Uint8Array(payload),digest=await contactDigest(bytes);guard(signal);const encoded=contactBase64(bytes);
      return Object.freeze({digest,async submit(signal:AbortSignal){
        const latest=await read(configuration.principal,kind,signal);guard(signal);
        if(latest.revision===revision+1&&latest.payload!==null){
          const retained=await contactDigest(contactBytes(latest.payload));guard(signal);if(retained===digest)return latest.revision;
        }
        if(latest.revision!==revision||(fence!==undefined&&latest.fence!==fence))return fail();
        const at=clock(),message=lengthPrefixed(['s3rch-contact-document-v1',configuration.tenant,configuration.source,configuration.principal,kind,String(revision),String(at),latest.fence,digest]);
        if(!message.ok)return fail();
        const scalar=Uint8Array.from(atob(held.priv.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
        let signature:string;
        try{const signed=signWithKeyring(scalar,message.value,writer.value);if(!signed.ok)return fail();signature=signed.value;}finally{scalar.fill(0);}
        guard(signal);const result=await request('write',{owner:configuration.principal,kind,evaluatedAt:at,revision,payload:encoded,signature,fence:latest.fence},signal) as {revision:number;digest:string};
        if(result.digest!==digest)return fail();return result.revision;
      }});
    },
  });
}
