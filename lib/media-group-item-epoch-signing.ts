import {signPrivateMediaGrant,signPrivateMediaEpoch,signPrivateMediaFinalization} from "sociacl-ids/private-media";
import {readGroupItemEpochPlan} from "./media-group-item-client";
import {parseGroupItemEpochPlan} from "./media-group-item-epoch";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";

/** Prepare one atomic command. Retaining it does not establish settlement or delivery. */
export async function prepareGroupItemEpoch(object:string,scopeInput:MediaGroupScope,owner:string,
  deviceId:string,scalar:Uint8Array,fetcher:typeof fetch,clock:()=>number,signal:AbortSignal){
  if(!(scalar instanceof Uint8Array)||scalar.length!==32||typeof deviceId!=="string"||!/^[\x21-\x7e]{1,128}$/.test(deviceId))
    throw Error("Group item signing unavailable");
  const scope=parseMediaGroupScope(scopeInput),key=new Uint8Array(scalar);
  const held=AbortSignal.any([signal,AbortSignal.timeout(4000)]);
  try{
    held.throwIfAborted();
    const plan=parseGroupItemEpochPlan(await readGroupItemEpochPlan(object,scope,owner,fetcher,clock,held),object,owner,scope,clock());
    const ownerPub=plan.ownerPub as string,previousEpoch=plan.previousEpoch as number,epoch=previousEpoch+1;
    const grants=(plan.grants as unknown[]).map(grant=>signPrivateMediaGrant(grant,key,ownerPub));
    const document=signPrivateMediaEpoch({object,previousEpoch,epoch,deviceId,keyCommitment:plan.keyCommitment,
      settleWindowMs:plan.settleWindowMs},plan.snapshot,key,ownerPub);
    const revisionId=document.manifest.revisionId;
    const finalization=signPrivateMediaFinalization({object,previousEpoch,epoch,revisionId,candidateRevisionIds:[revisionId],
      previousFinalizationId:plan.previousFinalizationId},key,ownerPub);
    held.throwIfAborted();
    // Recheck freshness after signing; never obtain a replacement fence here.
    parseGroupItemEpochPlan(plan,object,owner,scope,clock());
    const payload={grants,document,finalization};
    if(new TextEncoder().encode(JSON.stringify(payload)).length>262144)throw Error("Group item command too large");
    return {ownerPub,body:{object,...scope,at:plan.at as number,fence:plan.fence as string,payload}};
  }finally{key.fill(0);}
}
