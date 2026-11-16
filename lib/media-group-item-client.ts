import {parseGroupCommand,parseGroupCommandResult,groupResponseLimit} from "./media-group-command";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import type {MediaGroupScope} from "./media-group";
export type GroupItemContext=Readonly<{at:number;expiresAt:number;fence:string;object:string;ownerPub:string;
  predicate:MediaGroupScope["predicate"];set:string;item:Readonly<{epoch:number;revisionId:string;digest:string}>;
  group:Readonly<{epoch:number;revisionId:string;keyCommitment:string}>}>;
/** Current source context is independent of encrypted wrap labels. */
export async function readGroupItemContext(object:string,scope:MediaGroupScope,owner:string,
  fetcher:typeof fetch,clock:()=>number,signal:AbortSignal):Promise<GroupItemContext>{
  const body=parseGroupCommand("item-view",{object,...scope},owner);
  const held=AbortSignal.any([signal,AbortSignal.timeout(4000)]);held.throwIfAborted();
  const response=await fetcher("/api/media/groups/item-view",{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal:held,
    headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
    await response.body?.cancel().catch(()=>{});throw Error("Group item context unavailable");
  }
  const value=parseGroupCommandResult("item-view",await readBoundedIdentityJson(response,18432,held),body,clock(),owner);
  held.throwIfAborted();return value as GroupItemContext;
}
export function sameGroupItemContext(left:GroupItemContext,right:GroupItemContext){
  return left.object===right.object&&left.predicate===right.predicate&&left.set===right.set&&left.ownerPub===right.ownerPub&&
    left.item.epoch===right.item.epoch&&left.item.revisionId===right.item.revisionId&&left.item.digest===right.item.digest&&
    left.group.epoch===right.group.epoch&&left.group.revisionId===right.group.revisionId&&left.group.keyCommitment===right.group.keyCommitment;
}

/** Read-only owner maintenance preparation; never publishes or releases item keys. */
export async function readGroupItemEpochPlan(object:string,scope:MediaGroupScope,owner:string,
  fetcher:typeof fetch,clock:()=>number,signal:AbortSignal){
  const body=parseGroupCommand("item-epoch-view",{object,...scope},owner);
  const held=AbortSignal.any([signal,AbortSignal.timeout(4000)]);held.throwIfAborted();
  const response=await fetcher("/api/media/groups/item-epoch-view",{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal:held,
    headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
    await response.body?.cancel().catch(()=>{});throw Error("Group item epoch unavailable");
  }
  const value=parseGroupCommandResult("item-epoch-view",await readBoundedIdentityJson(response,groupResponseLimit("item-epoch-view"),held),body,clock(),owner);
  held.throwIfAborted();return value;
}
