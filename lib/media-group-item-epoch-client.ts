import {isSeaPubkey} from "./identity/forum-check";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {parseItemEpochCommand,parseItemEpochResult,parseSignedItemEpoch,type ItemEpochAction,type SignedItemEpoch} from "./media-group-item-epoch-command";
export type ItemEpochState={at:number;state:"applied"|"absent"};
const fail=():never=>{throw Error("Group item epoch could not be confirmed");};
export function createItemEpochClient(owner:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000){
  if(!isSeaPubkey(owner))return fail();
  const deadline=(signal?:AbortSignal)=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  async function request(action:ItemEpochAction,body:Record<string,unknown>,signal:AbortSignal){
    const parsed=parseItemEpochCommand(action,body,owner),raw=JSON.stringify(parsed);
    if(new TextEncoder().encode(raw).length>270336)return fail();signal.throwIfAborted();
    const response=await fetcher('/api/media/groups/'+action,{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:raw});
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='application/json'){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const value=parseItemEpochResult(action,await readBoundedIdentityJson(response,8192,signal),clock());
    signal.throwIfAborted();return value;
  }
  async function state(command:SignedItemEpoch,signal:AbortSignal){
    const {object,predicate,set,payload}=command.body;
    return await request('item-epoch-state',{object,predicate,set,payload},signal) as ItemEpochState;
  }
  return Object.freeze({
    state(input:SignedItemEpoch,signal?:AbortSignal){return state(parseSignedItemEpoch(input,owner),deadline(signal));},
    async apply(input:SignedItemEpoch,signal?:AbortSignal):Promise<ItemEpochState>{
      const command=parseSignedItemEpoch(input,owner),held=deadline(signal),current=await state(command,held);
      if(current.state==='applied')return current;
      if(current.at<(command.body.at as number)||current.at-(command.body.at as number)>4)return fail();
      await request('item-epoch-append',command.body,held);
      const result=await state(command,held);if(result.state!=='applied')return fail();return result;
    },
  });
}
