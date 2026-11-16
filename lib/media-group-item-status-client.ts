import {signPrivateMediaStatus} from "sociacl-ids/private-media";
import {isSeaPubkey} from "./identity/forum-check";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {parseItemStatusCommand,parseItemStatusResult,type ItemStatusAction,type ItemStatusState} from "./media-group-item-status";
export type SignedItemStatus={ownerPub:string;body:Record<string,unknown>};
const fail=():never=>{throw Error("Group item status could not be confirmed");};
export function parseSignedItemStatus(input:unknown,principal:string):SignedItemStatus {
  const v=structuredClone(input) as SignedItemStatus;
  if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==2||typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub))return fail();
  return {ownerPub:v.ownerPub,body:parseItemStatusCommand("item-status-append",v.body,principal)};
}
export function createItemStatusClient(principal:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000) {
  if(!isSeaPubkey(principal))return fail();
  const deadline=(signal?:AbortSignal)=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  async function request(action:ItemStatusAction,body:Record<string,unknown>,signal:AbortSignal) {
    const held=parseItemStatusCommand(action,body,principal),raw=JSON.stringify(held);
    if(new TextEncoder().encode(raw).length>(action==="item-status-view"?2048:8192))return fail();
    signal.throwIfAborted();
    const response=await fetcher("/api/media/groups/"+action,{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal,
      headers:{"Content-Type":"application/json"},body:raw});
    if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const result=parseItemStatusResult(action,await readBoundedIdentityJson(response,8192,signal),held,clock());
    signal.throwIfAborted();return result;
  }
  async function state(command:SignedItemStatus,signal:AbortSignal) {
    const {object,predicate,set,reader,payload}=command.body;
    return await request("item-status-state",{object,predicate,set,reader,payload},signal) as ItemStatusState;
  }
  return Object.freeze({
    async prepare(input:Record<string,unknown>,scalar:Uint8Array,signal?:AbortSignal):Promise<SignedItemStatus> {
      const body=parseItemStatusCommand("item-status-view",input,principal);
      if(!(scalar instanceof Uint8Array)||scalar.length!==32)return fail();
      const key=new Uint8Array(scalar),held=deadline(signal);
      try {
        const view=await request("item-status-view",body,held);
        const payload=signPrivateMediaStatus(view.status,key,view.ownerPub as string);
        held.throwIfAborted();
        parseItemStatusResult("item-status-view",view,body,clock());
        return parseSignedItemStatus({ownerPub:view.ownerPub,body:{object:body.object,predicate:body.predicate,set:body.set,reader:body.reader,at:view.at,fence:view.fence,payload}},principal);
      } finally {key.fill(0);}
    },
    state(input:SignedItemStatus,signal?:AbortSignal){return state(parseSignedItemStatus(input,principal),deadline(signal));},
    async apply(input:SignedItemStatus,signal?:AbortSignal):Promise<ItemStatusState> {
      const command=parseSignedItemStatus(input,principal),held=deadline(signal),current=await state(command,held);
      if(current.state==="applied")return current;
      if(current.at<(command.body.at as number)||current.at-(command.body.at as number)>4)return fail();
      const payload=command.body.payload as {signedAt:number;maxAgeMs:number};
      const now=clock();
      if(!Number.isFinite(now)||now*1000>=payload.signedAt+payload.maxAgeMs)return fail();
      // Preserve the original signed draft and fence on every retry.
      await request("item-status-append",command.body,held);
      const result=await state(command,held);
      if(result.state!=="applied")return fail();return result;
    },
  });
}
