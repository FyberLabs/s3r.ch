import {isSeaPubkey} from "./identity/forum-check";
import {isCanonicalObjectId} from "./identity/object-id";
import {objectPrincipal} from "./identity/forum-authority-records";
import {parseMediaGroupScope} from "./media-group";
export type ItemWrapAction="item-wrap-view"|"item-wrap-publish"|"item-wrap-read";
const fail=():never=>{throw Error("Group item wrap unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const fields=["itemEpoch","itemRevisionId","itemDigest","groupEpoch","groupRevisionId","groupKeyCommitment"];
function metadata(v:unknown,published:boolean){
  if(!exact(v,published?[...fields,"digest"]:fields)||!integer(v.itemEpoch)||v.itemEpoch<1||!integer(v.groupEpoch)||v.groupEpoch<1||
      !digest(v.itemRevisionId)||!digest(v.itemDigest)||!digest(v.groupRevisionId)||!digest(v.groupKeyCommitment)||(published&&!digest(v.digest)))return fail();
  return v;
}
function payload(v:unknown){
  if(typeof v!=="string"||!v.length||v.length>87384)return fail();
  try{const raw=atob(v);if(!raw.length||raw.length>65536||btoa(raw)!==v)return fail();}catch{return fail();}
}
export function parseItemWrapCommand(action:ItemWrapAction,input:unknown,principal:string):Record<string,unknown>{
  const v=structuredClone(input),keys=["object","predicate","set"];
  if(action!=="item-wrap-read")keys.push("reader");
  if(action==="item-wrap-publish")keys.push("at","fence","metadata","payload");
  if(!isSeaPubkey(principal)||!exact(v,keys)||typeof v.object!=="string"||!v.object.startsWith("media_")||!isCanonicalObjectId(v.object))return fail();
  parseMediaGroupScope({predicate:v.predicate,set:v.set});
  if(action!=="item-wrap-read"&&(objectPrincipal(v.object)!==principal||typeof v.reader!=="string"||!isSeaPubkey(v.reader)))return fail();
  if(action==="item-wrap-publish"){
    if(!integer(v.at)||!digest(v.fence))return fail();metadata(v.metadata,true);payload(v.payload);
  }
  return v;
}
export function parseItemWrapResult(action:ItemWrapAction,input:unknown,body:Record<string,unknown>,now:number){
  const v=structuredClone(input);
  if(action==="item-wrap-publish"){
    if(!exact(v,["digest"])||!digest(v.digest)||v.digest!==(body.metadata as Record<string,unknown>).digest)return fail();
  }else if(action==="item-wrap-view"){
    if(!exact(v,["at","fence","ownerPub","metadata"])||!integer(v.at)||!Number.isFinite(now)||v.at>now+1||now-v.at>4||
        !digest(v.fence)||typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub))return fail();metadata(v.metadata,false);
  }else{
    if(!exact(v,["payload","object","predicate","set_id","item_epoch","item_revision_id","item_digest","group_epoch","group_revision_id","group_key_commitment","expires_at"])||
        v.object!==body.object||v.predicate!==body.predicate||v.set_id!==body.set||!Number.isFinite(now)||
        !integer(v.expires_at)||v.expires_at<=now||v.expires_at>now+2)return fail();
    metadata({itemEpoch:v.item_epoch,itemRevisionId:v.item_revision_id,itemDigest:v.item_digest,groupEpoch:v.group_epoch,
      groupRevisionId:v.group_revision_id,groupKeyCommitment:v.group_key_commitment},false);payload(v.payload);
  }
  return v;
}
