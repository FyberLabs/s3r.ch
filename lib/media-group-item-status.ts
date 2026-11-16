import {isSeaPubkey} from "./identity/forum-check";
import {isCanonicalObjectId} from "./identity/object-id";
import {objectPrincipal} from "./identity/forum-authority-records";
import {parseMediaGroupScope} from "./media-group";
export type ItemStatusAction="item-status-view"|"item-status-append"|"item-status-state";
export type ItemStatusState={at:number;state:"applied"|"absent"};
const fail=():never=>{throw Error("Group item status unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
function status(input:unknown,object:string,reader:string,signed:boolean){
  const fields=["object","epoch","revisionId","accessor","grantRevision","stated","signedAt","maxAgeMs","zookie"];
  if(signed)fields.push("signature");
  if(!exact(input,fields)||input.object!==object||input.accessor!==reader||!integer(input.epoch)||input.epoch<1||!digest(input.revisionId)||
      !integer(input.grantRevision)||input.grantRevision<1||input.stated!==1||!integer(input.signedAt)||
      !integer(input.maxAgeMs)||input.maxAgeMs<1||input.maxAgeMs>60000||!Number.isSafeInteger(input.signedAt+input.maxAgeMs)||
      !exact(input.zookie,["object","objectVersion","snapshotHash"])||input.zookie.object!==object||!integer(input.zookie.objectVersion)||!digest(input.zookie.snapshotHash)||
      (signed&&(typeof input.signature!=="string"||!/^[a-f0-9]{128}$/.test(input.signature))))return fail();
  return input;
}
export function parseItemStatusCommand(action:ItemStatusAction,input:unknown,owner:string):Record<string,unknown>{
  const v=structuredClone(input),fields=["object","predicate","set","reader"];
  if(action!=="item-status-view")fields.push("payload");
  if(action==="item-status-append")fields.push("at","fence");
  if(!isSeaPubkey(owner)||!exact(v,fields)||typeof v.object!=="string"||!v.object.startsWith("media_")||!isCanonicalObjectId(v.object)||objectPrincipal(v.object)!==owner||
      typeof v.reader!=="string"||!isSeaPubkey(v.reader))return fail();
  parseMediaGroupScope({predicate:v.predicate,set:v.set});
  if(action!=="item-status-view"){
    const payload=status(v.payload,v.object,v.reader,true);
    if(action==="item-status-append"&&(!integer(v.at)||!digest(v.fence)||payload.signedAt!==v.at*1000))return fail();
  }
  return v;
}
export function parseItemStatusResult(action:ItemStatusAction,input:unknown,body:Record<string,unknown>,now:number){
  const v=structuredClone(input);
  if(action==="item-status-append"){
    if(!exact(v,["accepted"])||v.accepted!==true)return fail();return v;
  }
  if(!exact(v,action==="item-status-state"?["at","state"]:["at","fence","ownerPub","status"])||!integer(v.at)||
      !Number.isFinite(now)||v.at>now+1||now-v.at>4)return fail();
  if(action==="item-status-state"){
    if(!["applied","absent"].includes(v.state as string))return fail();
  }else{
    if(!digest(v.fence)||typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub))return fail();
    const payload=status(v.status,body.object as string,body.reader as string,false);
    if(payload.signedAt!==v.at*1000||(payload.signedAt as number)+(payload.maxAgeMs as number)<=now*1000)return fail();
  }
  return v;
}
