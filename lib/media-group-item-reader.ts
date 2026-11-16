import {openGroupEpochWrap} from "sociacl-ids/group-wrap";
import {createGroupWrapClient} from "./media-group-wrap-client";
import {parseGroupCommand,parseGroupCommandResult} from "./media-group-command";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {MEDIA_STORED_MAX} from "./media-crypto";
const fail=():never=>{throw Error("Group item access could not be confirmed");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
/** The caller owns the returned DEK and must erase it after use. Group-key
 * possession alone never authorizes an item; both reads use current joint ACL. */
export async function openGroupItem(input:{principal:string;object:string;scope:MediaGroupScope;epriv:string;epub:string;
  fetcher?:typeof fetch;clock?:()=>number;signal:AbortSignal}){
  const {principal,object,epriv,epub}=input,scope=parseMediaGroupScope(input.scope),fetcher=input.fetcher??fetch,clock=input.clock??(()=>Date.now()/1000);
  const body=parseGroupCommand("item-wrap-read",{object,...scope},principal),signal=AbortSignal.any([input.signal,AbortSignal.timeout(4000)]);
  async function read(){
    signal.throwIfAborted();
    const response=await fetcher('/api/media/groups/item-wrap-read',{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const value=parseGroupCommandResult("item-wrap-read",await readBoundedIdentityJson(response,92160,signal),body,clock(),principal);
    signal.throwIfAborted();return value;
  }
  const group=await createGroupWrapClient(principal,fetcher,clock).openCurrent(scope,epriv,epub,signal);
  let dek:Uint8Array|undefined;
  try{
    const current=await read();
    if(current.group_epoch!==group.epoch||current.group_revision_id!==group.revisionId||current.group_key_commitment!==group.keyCommitment||clock()>=group.expiresAt)return fail();
    const bytes=Uint8Array.from(atob(current.payload as string),c=>c.charCodeAt(0));
    const material=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!exact(material,["wrap","reference"])||!exact(material.reference,["sha256","length"])||material.reference.sha256!==current.item_digest||
        !Number.isSafeInteger(material.reference.length)||(material.reference.length as number)<33||(material.reference.length as number)>MEDIA_STORED_MAX)return fail();
    const opened=await openGroupEpochWrap(material.wrap,group.key,{object,group:scope.set,epoch:current.item_epoch,revisionId:current.item_revision_id});
    if(!opened.ok)return fail();dek=opened.value;
    // Recheck after crypto so a revoked or changed item never yields a key.
    const final=await read();
    for(const field of ["payload","item_epoch","item_revision_id","item_digest","group_epoch","group_revision_id","group_key_commitment"])
      if(final[field]!==current[field])return fail();
    if(clock()>=group.expiresAt||clock()>=(final.expires_at as number))return fail();
    signal.throwIfAborted();
    const key=dek;dek=undefined;
    return {key,reference:{sha256:material.reference.sha256 as string,length:material.reference.length as number},
      object,epoch:current.item_epoch as number,revisionId:current.item_revision_id as string};
  }finally{group.key.fill(0);dek?.fill(0);}
}
