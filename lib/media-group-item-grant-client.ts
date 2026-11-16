import {signPrivateMediaGrant} from "sociacl-ids/private-media";
import {isSeaPubkey} from "./identity/forum-check";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {parseItemGrantCommand,parseItemGrantResult,type ItemGrantAction,type ItemGrantState} from "./media-group-item-grant";
export type SignedItemGrant={ownerPub:string;body:Record<string,unknown>};
const fail=():never=>{throw Error("Group item grant could not be confirmed");};
export function parseSignedItemGrant(input:unknown,principal:string):SignedItemGrant {
  const v=structuredClone(input) as SignedItemGrant;
  if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==2||typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub))return fail();
  return {ownerPub:v.ownerPub,body:parseItemGrantCommand("item-grant-append",v.body,principal)};
}
export function createItemGrantClient(principal:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000) {
  if(!isSeaPubkey(principal))return fail();
  const deadline=(signal?:AbortSignal)=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  async function request(action:ItemGrantAction,body:Record<string,unknown>,signal:AbortSignal) {
    const held=parseItemGrantCommand(action,body,principal),raw=JSON.stringify(held);
    if(new TextEncoder().encode(raw).length>(action==="item-grant-view"?2048:8192))return fail();
    signal.throwIfAborted();
    const response=await fetcher("/api/media/groups/"+action,{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal,
      headers:{"Content-Type":"application/json"},body:raw});
    if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const result=parseItemGrantResult(action,await readBoundedIdentityJson(response,8192,signal),held,clock(),principal);
    signal.throwIfAborted();return result;
  }
  async function state(command:SignedItemGrant,signal:AbortSignal) {
    const {object,predicate,set,payload}=command.body;
    return await request("item-grant-state",{object,predicate,set,payload},signal) as ItemGrantState;
  }
  return Object.freeze({
    async prepare(input:Record<string,unknown>,scalar:Uint8Array,signal?:AbortSignal):Promise<SignedItemGrant> {
      const body=parseItemGrantCommand("item-grant-view",input,principal);
      if(!(scalar instanceof Uint8Array)||scalar.length!==32)return fail();
      const key=new Uint8Array(scalar),held=deadline(signal);
      try {
        const view=await request("item-grant-view",body,held);
        const payload=signPrivateMediaGrant(view.grant,key,view.ownerPub as string);
        held.throwIfAborted();
        return parseSignedItemGrant({ownerPub:view.ownerPub,body:{object:body.object,predicate:body.predicate,set:body.set,at:view.at,fence:view.fence,payload}},principal);
      } finally {key.fill(0);}
    },
    state(input:SignedItemGrant,signal?:AbortSignal){return state(parseSignedItemGrant(input,principal),deadline(signal));},
    async apply(input:SignedItemGrant,signal?:AbortSignal):Promise<ItemGrantState> {
      const command=parseSignedItemGrant(input,principal),held=deadline(signal),current=await state(command,held);
      if(current.state==="applied")return current;
      if(current.frozen||current.at<(command.body.at as number)||current.at-(command.body.at as number)>4)return fail();
      // Preserve the original signed draft and fence on every retry.
      await request("item-grant-append",command.body,held);
      const result=await state(command,held);
      if(result.state!=="applied")return fail();return result;
    },
  });
}
