import {parseGroupKeySnapshot,signPrivateGroupEpoch,signPrivateGroupFinalization} from "sociacl-ids/private-media";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {parseGroupCommand,parseGroupCommandResult,groupRequestLimit,groupResponseLimit,type GroupCommandAction} from "./media-group-command";
import {readBoundedIdentityJson} from "./identity/bounded-json";
import {isSeaPubkey} from "./identity/forum-check";

export type SignedGroupKeyCommand=Readonly<{predicate:"same-group"|"named-circle";set:string;command:Record<string,unknown>}>;
const fail=():never=>{throw Error("Group key command could not be confirmed");};
export function parseSignedGroupKeyCommand(input:unknown,principal:string):SignedGroupKeyCommand {
  return parseGroupCommand("key-state",input,principal) as SignedGroupKeyCommand;
}

/** Uses current protected preparation. Exact replay never creates another key/signature. */
export function createGroupKeyClient(principal:string,fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000) {
  if(!isSeaPubkey(principal))return fail();
  const deadline=(signal?:AbortSignal)=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  async function request(action:GroupCommandAction,body:Record<string,unknown>,signal:AbortSignal){
    const parsed=parseGroupCommand(action,body,principal),raw=JSON.stringify(parsed);
    if(new TextEncoder().encode(raw).length>groupRequestLimit(action))return fail();
    signal.throwIfAborted();
    const response=await fetcher("/api/media/groups/"+action,{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",signal,
      headers:{"Content-Type":"application/json"},body:raw});
    if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const result=parseGroupCommandResult(action,await readBoundedIdentityJson(response,groupResponseLimit(action),signal),parsed,clock(),principal);
    signal.throwIfAborted();return result;
  }
  return Object.freeze({
    async allocate(scope:MediaGroupScope,signal?:AbortSignal){
      await request("allocate",parseMediaGroupScope(scope),deadline(signal));
    },
    async prepare(scope:MediaGroupScope,deviceId:string,groupKey:Uint8Array,scalar:Uint8Array,signal?:AbortSignal):Promise<SignedGroupKeyCommand>{
      if(!(scalar instanceof Uint8Array)||scalar.length!==32||!(groupKey instanceof Uint8Array)||groupKey.length!==32)return fail();
      const signer=new Uint8Array(scalar),secret=new Uint8Array(groupKey),held=deadline(signal);
      try{
        const view=await request("key-view",parseMediaGroupScope(scope),held);
        const snapshot=parseGroupKeySnapshot(view.snapshot),config=view.config as {settleWindowMs:number};
        const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",secret));
        const keyCommitment=Array.from(hash,byte=>byte.toString(16).padStart(2,"0")).join("");
        held.throwIfAborted();
        const document=signPrivateGroupEpoch({object:scope.set,previousEpoch:view.previousEpoch,epoch:(view.previousEpoch as number)+1,
          deviceId,keyCommitment,settleWindowMs:config.settleWindowMs},snapshot,signer,snapshot.ownerSigningPub);
        const finalization=signPrivateGroupFinalization({object:scope.set,previousEpoch:view.previousEpoch,epoch:document.manifest.epoch,
          revisionId:document.manifest.revisionId,candidateRevisionIds:[document.manifest.revisionId],previousFinalizationId:view.previousFinalizationId},signer,snapshot.ownerSigningPub);
        held.throwIfAborted();
        return parseSignedGroupKeyCommand({...parseMediaGroupScope(scope),command:{document,finalization}},principal);
      }finally{signer.fill(0);secret.fill(0);}
    },
    async state(input:SignedGroupKeyCommand,signal?:AbortSignal){
      return request("key-state",parseSignedGroupKeyCommand(input,principal),deadline(signal)) as Promise<{at:number;state:"applied"|"absent";fence:string}>;
    },
    async apply(input:SignedGroupKeyCommand,signal?:AbortSignal,beforeAppend?:(at:number)=>Promise<void>){
      const command=parseSignedGroupKeyCommand(input,principal),held=deadline(signal),current=await request("key-state",command,held);
      if(current.state==="applied")return;
      if(beforeAppend)await beforeAppend(current.at as number);
      held.throwIfAborted();
      await request("key-append",{...command,at:current.at,fence:current.fence},held);
    },
  });
}
