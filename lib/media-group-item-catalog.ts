import {isSeaPubkey} from "./identity/forum-check";
import {isCanonicalObjectId} from "./identity/object-id";
import {objectPrincipal} from "./identity/forum-authority-records";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
export type GroupGrantedEntry=MediaGroupScope & Readonly<{object:string}>;
export type GroupGrantedPage=Readonly<{at:number;entries:readonly GroupGrantedEntry[];nextPage:number|null}>;
const fail=():never=>{throw Error("Granted group media unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function parseGroupGrantedRequest(input:unknown,principal:string):{page:number}{
  if(!isSeaPubkey(principal)||!exact(input,["page"])||!Number.isSafeInteger(input.page)||(input.page as number)<0||(input.page as number)>15)return fail();
  return {page:input.page as number};
}
export function parseGroupGrantedPage(input:unknown,page:number,principal:string,now:number):GroupGrantedPage{
  parseGroupGrantedRequest({page},principal);const v=structuredClone(input);
  if(!exact(v,["at","entries","nextPage"])||!Number.isSafeInteger(v.at)||(v.at as number)<0||!Number.isFinite(now)||
      (v.at as number)>now+1||now-(v.at as number)>4||v.nextPage!==(page===15?null:page+1)||!Array.isArray(v.entries)||v.entries.length>4)return fail();
  let previous="";
  for(const entry of v.entries){
    if(!exact(entry,["object","predicate","set"])||typeof entry.object!=="string"||!entry.object.startsWith("media_")||
        !isCanonicalObjectId(entry.object)||objectPrincipal(entry.object)===principal||entry.object<=previous)return fail();
    parseMediaGroupScope({predicate:entry.predicate,set:entry.set});previous=entry.object;
  }
  return v as GroupGrantedPage;
}
