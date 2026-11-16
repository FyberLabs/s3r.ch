import {parseGroupItemEpochPlan} from "./media-group-item-epoch";
import {parseMediaGroupScope} from "./media-group";
import {parseItemGrantCommand} from "./media-group-item-grant";
import {isSeaPubkey} from "./identity/forum-check";
import {isCanonicalObjectId} from "./identity/object-id";
import {objectPrincipal} from "./identity/forum-authority-records";
export type ItemEpochAction="item-epoch-append"|"item-epoch-state";
export type SignedItemEpoch={ownerPub:string;plan:Record<string,unknown>;body:Record<string,unknown>};
const fail=():never=>{throw Error("Group item epoch command unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const signature=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{128}$/.test(v);
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(",")}]`:v&&typeof v==="object"?
  `{${Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical((v as Record<string,unknown>)[k])).join(",")}}`:JSON.stringify(v)??fail();
export function parseItemEpochCommand(action:ItemEpochAction,input:unknown,owner:string){
  const v=structuredClone(input);
  if(!isSeaPubkey(owner)||!exact(v,action==="item-epoch-append"?["object","predicate","set","at","fence","payload"]:["object","predicate","set","payload"])||
      typeof v.object!=="string"||!v.object.startsWith("media_")||!isCanonicalObjectId(v.object)||objectPrincipal(v.object)!==owner)return fail();
  const scope=parseMediaGroupScope({predicate:v.predicate,set:v.set});
  if(action==="item-epoch-append"&&(!integer(v.at)||!digest(v.fence)))return fail();
  const p=v.payload;
  if(!exact(p,["grants","document","finalization"])||new TextEncoder().encode(JSON.stringify(p)).length>262144||
      !Array.isArray(p.grants)||p.grants.length<1||p.grants.length>64||!exact(p.document,["manifest","snapshot"]))return fail();
  const m=p.document.manifest,f=p.finalization,s=p.document.snapshot;
  if(!exact(m,["object","previousEpoch","epoch","deviceId","keyCommitment","settleWindowMs","aclSnapshot","revisionId","signature"])||
      m.object!==v.object||!integer(m.previousEpoch)||m.previousEpoch<1||!integer(m.epoch)||m.epoch!==m.previousEpoch+1||
      typeof m.deviceId!=="string"||!/^[\x21-\x7e]{1,128}$/.test(m.deviceId)||!digest(m.keyCommitment)||!digest(m.aclSnapshot)||!digest(m.revisionId)||!signature(m.signature)||
      !integer(m.settleWindowMs)||m.settleWindowMs<3600000||m.settleWindowMs>259200000)return fail();
  if(!exact(f,["object","previousEpoch","epoch","revisionId","candidateRevisionIds","previousFinalizationId","finalizationId","signature"])||
      f.object!==v.object||f.previousEpoch!==m.previousEpoch||f.epoch!==m.epoch||f.revisionId!==m.revisionId||
      !Array.isArray(f.candidateRevisionIds)||f.candidateRevisionIds.length!==1||f.candidateRevisionIds[0]!==m.revisionId||
      !digest(f.previousFinalizationId)||!digest(f.finalizationId)||!signature(f.signature))return fail();
  if(!exact(s,["entries","objectSet"])||!Array.isArray(s.entries)||s.entries.length<1||s.entries.length>64||
      !exact(s.objectSet,["predicate","setId","stated","hamState"])||s.objectSet.predicate!==scope.predicate||s.objectSet.setId!==scope.set||
      ![0,1].includes(s.objectSet.stated as number)||!integer(s.objectSet.hamState))return fail();
  let prior="";
  for(const e of s.entries){
    if(!exact(e,["accessor","grantRevision","stated","from","until","scope","setId","hamState"])||typeof e.accessor!=="string"||!isSeaPubkey(e.accessor)||e.accessor<=prior||
        !integer(e.grantRevision)||e.grantRevision<1||![0,1].includes(e.stated as number)||!integer(e.from)||!integer(e.until)||e.until<=e.from||!integer(e.hamState)||
        (e.scope==="direct"?(e.setId!==""||e.hamState!==0):(e.scope!==scope.predicate||e.setId!==scope.set||(e.stated===1&&s.objectSet.stated!==1))))return fail();
    prior=e.accessor;
  }
  prior="";
  for(const grant of p.grants){
    parseItemGrantCommand("item-grant-state",{object:v.object,...scope,payload:grant},owner);
    const claims=(grant as {claims:{accessor:string;epoch:number}}).claims;
    if(claims.accessor<=prior||claims.epoch!==m.epoch)return fail();prior=claims.accessor;
  }
  return v;
}
export function parseSignedItemEpoch(input:unknown,owner:string):SignedItemEpoch{
  const v=structuredClone(input);
  if(!exact(v,["ownerPub","plan","body"])||typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub))return fail();
  const body=parseItemEpochCommand("item-epoch-append",v.body,owner),scope=parseMediaGroupScope({predicate:body.predicate,set:body.set});
  const plan=parseGroupItemEpochPlan(v.plan,body.object as string,owner,scope,body.at as number);
  const p=body.payload as {grants:{claims:unknown}[];document:{manifest:Record<string,unknown>;snapshot:unknown};finalization:Record<string,unknown>},m=p.document.manifest;
  if(plan.at!==body.at||plan.fence!==body.fence||plan.ownerPub!==v.ownerPub||m.previousEpoch!==plan.previousEpoch||
      m.keyCommitment!==plan.keyCommitment||m.settleWindowMs!==plan.settleWindowMs||p.finalization.previousFinalizationId!==plan.previousFinalizationId||
      canonical(p.grants.map(g=>g.claims))!==canonical(plan.grants)||canonical(p.document.snapshot)!==canonical(plan.snapshot))return fail();
  return {ownerPub:v.ownerPub,plan,body};
}
export function parseItemEpochResult(action:ItemEpochAction,input:unknown,now:number){
  const v=structuredClone(input);
  if(action==="item-epoch-append"){
    if(!exact(v,["accepted"])||v.accepted!==true)return fail();return v;
  }
  if(!exact(v,["at","state"])||!integer(v.at)||!Number.isFinite(now)||v.at>now+1||now-v.at>4||!["applied","absent"].includes(v.state as string))return fail();
  return v;
}
