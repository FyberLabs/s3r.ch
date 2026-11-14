import { createHash } from "node:crypto";
import { objectPrincipal } from "./identity/forum-authority-records";
import { isCanonicalObjectId } from "./identity/object-id";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { OBJECT_BYTES_MAX } from "./object-store";

export interface AllocatedMediaStore {
  reference(object:string,signal:AbortSignal):Promise<{digest:string;length:number}|null>;
  get(object:string,digest:string,signal:AbortSignal):Promise<Uint8Array>;
  put(object:string,digest:string,bytes:Uint8Array,signal:AbortSignal):Promise<void>;
}
const digestOK=(value:unknown):value is string=>typeof value==="string" && /^[0-9a-f]{64}$/.test(value);
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

/** Server-owned configuration only. Every consumer operation still needs ACL authorization. */
export function createAllocatedMediaStore(config:Readonly<{origin:string;tenant:string;apiKey:string}>,fetcher:typeof fetch=fetch):AllocatedMediaStore {
  const origin=new URL(config.origin);
  if(origin.protocol!=="https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=="/" || origin.port ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(config.tenant) ||
    config.tenant==="00000000-0000-0000-0000-000000000000" || typeof config.apiKey!=="string" || !/^[\x21-\x7e]{1,4096}$/.test(config.apiKey))throw Error("Invalid media storage configuration");
  const base=origin.origin+"/api/v1/storage/media/payloads/";
  const headers={"X-Api-Key":config.apiKey,"X-Tenant-ID":config.tenant,"Accept-Encoding":"identity"};
  async function request<T>(object:string,digest:string|undefined,bytes:Uint8Array|undefined,signal:AbortSignal,consume:(response:Response,deadline:AbortSignal)=>Promise<T>) {
    if(!object.startsWith("media_") || !isCanonicalObjectId(object) || (digest!==undefined && !digestOK(digest)))throw Error("Invalid media reference");
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(120000)]);let response:Response|undefined;
    try {
      deadline.throwIfAborted();
      response=await fetcher(base+object+"/ciphertext"+(digest?"/"+digest:""),{
        method:bytes?"PUT":"GET",redirect:"error",cache:"no-store",credentials:"omit",signal:deadline,
        headers:{...headers,...(bytes?{"X-Media-Owner":objectPrincipal(object)!,"Content-Type":"application/octet-stream","Content-Length":String(bytes.length)}:{})},
        body:bytes?new Uint8Array(bytes):undefined,
      });
      deadline.throwIfAborted();const result=await consume(response,deadline);deadline.throwIfAborted();return result;
    }catch {throw Error("Allocated media storage unavailable");}
    finally{if(response?.body && !response.body.locked)await response.body.cancel().catch(()=>{});}
  }
  return Object.freeze({
    reference(object,signal) {
      return request(object,undefined,undefined,signal,async(response,deadline)=>{
        if(response.status===404)return null;
        if(response.status!==200 || response.headers.get("content-type")?.split(";")[0]!=="application/json" ||
          ![null,"identity"].includes(response.headers.get("content-encoding")))throw Error();
        const value=await readBoundedIdentityJson(response,2048,deadline);
        if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join()!=="length,sha256")throw Error();
        const row=value as Record<string,unknown>;
        if(!digestOK(row.sha256) || !Number.isSafeInteger(row.length) || (row.length as number)<33 || (row.length as number)>OBJECT_BYTES_MAX)throw Error();
        return {digest:row.sha256,length:row.length as number};
      });
    },
    get(object,digest,signal) {
      return request(object,digest,undefined,signal,async(response,deadline)=>{
        const length=response.headers.get("content-length");
        if(response.status!==200 || response.headers.get("etag")!=='"'+digest+'"' || !response.body ||
          ![null,"identity"].includes(response.headers.get("content-encoding")) || !length || !/^[1-9][0-9]{0,7}$/.test(length) ||
          Number(length)<33 || Number(length)>OBJECT_BYTES_MAX)throw Error();
        const reader=response.body.getReader(),bytes=new Uint8Array(Number(length));let offset=0;
        try {
          while(true){deadline.throwIfAborted();const part=await reader.read();deadline.throwIfAborted();if(part.done)break;
            if(offset+part.value.length>bytes.length)throw Error();bytes.set(part.value,offset);offset+=part.value.length;}
        }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        if(offset!==bytes.length || hash(bytes)!==digest)throw Error();return bytes;
      });
    },
    async put(object,digest,input,signal) {
      if(!(input instanceof Uint8Array) || input.length<33 || input.length>OBJECT_BYTES_MAX || hash(input)!==digest)throw Error("Invalid media bytes");
      const bytes=new Uint8Array(input);
      await request(object,digest,bytes,signal,async response=>{
        if(![201,204].includes(response.status) || response.headers.get("etag")!=='"'+digest+'"')throw Error();
      });
    },
  });
}
