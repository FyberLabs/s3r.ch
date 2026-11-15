import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {parseGroupKeySnapshot} from "./media-group-key";
import {objectPrincipal} from "./identity/forum-authority-records";
import {isSeaPubkey} from "./identity/forum-check";

export type GroupWrapAction="wrap-view"|"wrap-publish"|"wrap-read";
const fail=():never=>{throw Error("Group wrap unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const pub=(v:unknown):v is string=>typeof v==="string"&&isSeaPubkey(v);
function payload(value:unknown){
  if(typeof value!=="string"||value.length>87384||!value.length)return fail();
  try{const raw=atob(value);if(!raw.length||raw.length>65536||btoa(raw)!==value)return fail();}catch{return fail();}
  return value;
}
export function parseGroupWrapCommand(action:GroupWrapAction,input:unknown,principal:string){
  const body=structuredClone(input),fields=action==="wrap-publish"?["predicate","set","at","fence","metadata","payload"]:["predicate","set"];
  if(!pub(principal)||!exact(body,fields))return fail();
  const scope=parseMediaGroupScope({predicate:body.predicate,set:body.set});
  if(action!=="wrap-read"&&objectPrincipal(scope.set)!==principal)return fail();
  if(action==="wrap-publish"){
    const m=body.metadata;
    if(!integer(body.at)||!digest(body.fence)||!exact(m,["reader","readerEpub","epoch","revisionId","digest"])||
        !pub(m.reader)||!pub(m.readerEpub)||!integer(m.epoch)||m.epoch<1||!digest(m.revisionId)||!digest(m.digest))return fail();
    payload(body.payload);
  }
  return body;
}
function manifest(value:unknown,scope:MediaGroupScope){
  if(!exact(value,["object","previousEpoch","epoch","deviceId","revisionId","keyCommitment","settleWindowMs","aclSnapshot","signature"])||
      value.object!==scope.set||!integer(value.previousEpoch)||!integer(value.epoch)||value.epoch!==value.previousEpoch+1||
      typeof value.deviceId!=="string"||!/^[\x21-\x7e]{1,128}$/.test(value.deviceId)||
      !digest(value.revisionId)||!digest(value.keyCommitment)||!digest(value.aclSnapshot)||
      typeof value.signature!=="string"||!/^[a-f0-9]{128}$/.test(value.signature)||
      !integer(value.settleWindowMs)||value.settleWindowMs<3600000||value.settleWindowMs>259200000)return fail();
  return value;
}
export function parseGroupWrapResult(action:GroupWrapAction,input:unknown,body:Record<string,unknown>,now:number){
  const value=structuredClone(input),scope=parseMediaGroupScope({predicate:body.predicate,set:body.set});
  if(action==="wrap-publish"){
    if(!exact(value,["digest"])||!digest(value.digest)||value.digest!==(body.metadata as Record<string,unknown>).digest)return fail();
  }else if(action==="wrap-view"){
    if(!exact(value,["at","fence","snapshot","manifest"])||!integer(value.at)||value.at>now+1||now-value.at>4||!digest(value.fence))return fail();
    parseGroupKeySnapshot(value.snapshot,scope);manifest(value.manifest,scope);
  }else{
    if(!exact(value,["payload","predicate","set_id","epoch","revision_id","reader_epub","key_commitment","expires_at"])||
        value.predicate!==scope.predicate||value.set_id!==scope.set||!integer(value.epoch)||value.epoch<1||
        !digest(value.revision_id)||!pub(value.reader_epub)||!digest(value.key_commitment)||
        !integer(value.expires_at)||value.expires_at<=now||value.expires_at>now+2)return fail();
    payload(value.payload);
  }
  return value;
}
