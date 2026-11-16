import {parseItemGrantCommand,parseItemGrantResult} from "./media-group-item-grant";
import {parseGroupWrapCommand,parseGroupWrapResult} from "./media-group-wrap";
import {parseGroupKeyCommand,parseGroupKeyView} from "./media-group-key";
import {parseMediaGroupScope,parseMediaGroupPolicy,parseMediaGroupView} from "./media-group";
import {objectPrincipal,parseForumAuthority} from "./identity/forum-authority-records";
import {isCanonicalObjectId} from "./identity/object-id";
import {isSeaPubkey} from "./identity/forum-check";

export type GroupCatalogEntry=Readonly<{predicate:"same-group"|"named-circle";set:string;owner:string;owned:boolean;invited:boolean;active:boolean}>;
export type GroupCatalog=Readonly<{at:number;groups:readonly GroupCatalogEntry[];nextPage:number|null;principal:string}>;

export const groupCommandFields={
  catalog:["page"],
  "item-grant-view":["object","predicate","set","reader","withdraw"],
  "item-grant-append":["object","predicate","set","at","fence","payload"],
  "item-grant-state":["object","predicate","set","payload"],
  "item-view":["object","predicate","set"],
  "item-authority-view":["object"],
  allocate:["predicate","set"],
  "wrap-view":["predicate","set"],
  "wrap-publish":["predicate","set","at","fence","metadata","payload"],
  "wrap-read":["predicate","set"],
  "key-view":["predicate","set"],
  "key-append":["predicate","set","at","fence","command"],
  "key-state":["predicate","set","command"],
  "create-view":["object","predicate","set"],
  create:["object","predicate","set","at","fence","config"],
  "create-state":["object","predicate","set","config"],
  "member-view":["predicate","set","member","role","stated"],
  "member-append":["predicate","set","member","role","at","fence","row"],
  "member-state":["predicate","set","member","role","row"],
} as const;
export type GroupCommandAction=keyof typeof groupCommandFields;
const fail=():never=>{throw Error("Group command unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
export const isGroupCommand=(action:string):action is GroupCommandAction=>Object.hasOwn(groupCommandFields,action);

/** Shape and authenticated-party checks. Native ACL remains the signature authority. */
export function parseGroupCommand(action:GroupCommandAction,input:unknown,principal:string) {
  if(action==="wrap-view"||action==="wrap-publish"||action==="wrap-read")return parseGroupWrapCommand(action,input,principal);
  if(action==="item-grant-view"||action==="item-grant-append"||action==="item-grant-state")return parseItemGrantCommand(action,input,principal);
  const body=structuredClone(input);
  if(!isSeaPubkey(principal)||!exact(body,groupCommandFields[action]))return fail();
  if(action==="catalog"){if(!integer(body.page)||body.page>15)return fail();return body;}
  if(action==="item-authority-view"){
    if(typeof body.object!=="string"||!body.object.startsWith("media_")||!isCanonicalObjectId(body.object)||objectPrincipal(body.object)!==principal)return fail();
    return body;
  }
  const scope=parseMediaGroupScope({predicate:body.predicate,set:body.set}),owner=objectPrincipal(scope.set);
  if(action==="item-view"){
    if(typeof body.object!=="string"||!body.object.startsWith("media_")||!isCanonicalObjectId(body.object)||objectPrincipal(body.object)!==principal)return fail();
  } else if(action.startsWith("key-")||action==="allocate"){
    if(owner!==principal)return fail();
    if("command" in body)parseGroupKeyCommand(body.command,scope);
  } else if(action.startsWith("create")) {
    if(owner!==principal||typeof body.object!=="string"||!body.object.startsWith("media_")||!isCanonicalObjectId(body.object)||objectPrincipal(body.object)!==principal)return fail();
    if("config" in body)parseMediaGroupPolicy(body.config,scope);
  } else {
    if(typeof body.member!=="string"||!isSeaPubkey(body.member)||!["set","member"].includes(body.role as string)||
        (body.role==="set"?owner:body.member)!==principal)return fail();
    if("stated" in body&&body.stated!==0&&body.stated!==1)return fail();
    if("row" in body) {
      const row=body.row;
      if(!exact(row,["kind","soul","record"])||row.kind!=="membership")return fail();
      const parsed=parseForumAuthority("membership",row.record);
      if(!parsed||parsed.kind!=="membership"||parsed.soul!==row.soul||parsed.row.role!==body.role||
          parsed.row.member!==body.member||parsed.row.predicate!==scope.predicate||parsed.row.set!==scope.set)return fail();
    }
  }
  if("at" in body&&(!integer(body.at)||!digest(body.fence)))return fail();
  return body;
}

/** Reject a mismatched preparation before a browser can sign or persist it. */
export function parseGroupCommandResult(action:GroupCommandAction,input:unknown,body:Record<string,unknown>,now:number,principal?:string) {
  if(action==="wrap-view"||action==="wrap-publish"||action==="wrap-read")return parseGroupWrapResult(action,input,body,now);
  if(action==="item-grant-view"||action==="item-grant-append"||action==="item-grant-state"){
    if(!principal)return fail();return parseItemGrantResult(action,input,body,now,principal);
  }
  const value=structuredClone(input);
  if(action==="catalog") {
    if(!principal||!exact(value,["at","groups","nextPage","principal"])||value.principal!==principal||
        !integer(value.at)||value.at>now+1||now-value.at>4||!Array.isArray(value.groups)||value.groups.length>4||
        value.nextPage!==(body.page===15?null:(body.page as number)+1))return fail();
    const seen=new Set<string>();
    for(const row of value.groups){
      if(!exact(row,["predicate","set","owner","owned","invited","active"]))return fail();
      const scope=parseMediaGroupScope({predicate:row.predicate,set:row.set});
      const id=JSON.stringify(scope);
      if(seen.has(id)||row.owner!==objectPrincipal(scope.set)||typeof row.owned!=="boolean"||
          row.owned!==(row.owner===principal)||typeof row.invited!=="boolean"||typeof row.active!=="boolean"||
          (!row.owned&&!row.invited&&!row.active))return fail();
      seen.add(id);
    }
    return value;
  }
  if(action==="item-authority-view"){
    if(!exact(value,["at","fence","objectVersion","projection","ownerPub"])||typeof body.object!=="string"||
        !integer(value.at)||value.at>now+1||now-value.at>4||typeof value.ownerPub!=="string"||!isSeaPubkey(value.ownerPub))return fail();
    const {ownerPub,...projection}=value;
    return {...parseMediaGroupView(projection,body.object),ownerPub};
  }
  const scope=parseMediaGroupScope({predicate:body.predicate,set:body.set});
  if(action==="allocate"){
    if(!exact(value,["predicate","set","accepted"])||value.predicate!==scope.predicate||value.set!==scope.set||value.accepted!==true)return fail();
    return value;
  }
  if(action==="create"||action==="member-append"||action==="key-append") {
    if(!exact(value,["accepted"])||value.accepted!==true)return fail();return value;
  }
  if(!value||typeof value!=="object"||Array.isArray(value))return fail();
  const v=value as Record<string,unknown>;
  if(!integer(v.at)||v.at>now+1||now-v.at>4)return fail();
  if(action==="item-view"){
    if(!exact(v,["at","expiresAt","fence","object","predicate","set","ownerPub","item","group"])||
        v.object!==body.object||v.predicate!==scope.predicate||v.set!==scope.set||!digest(v.fence)||
        typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub)||!integer(v.expiresAt)||
        v.expiresAt<=now||v.expiresAt>now+2||v.expiresAt<=v.at||v.expiresAt>v.at+2||
        !exact(v.item,["epoch","revisionId","digest"])||!integer(v.item.epoch)||v.item.epoch<1||
        !digest(v.item.revisionId)||!digest(v.item.digest)||
        !exact(v.group,["epoch","revisionId","keyCommitment"])||!integer(v.group.epoch)||v.group.epoch<1||
        !digest(v.group.revisionId)||!digest(v.group.keyCommitment))return fail();
    return v;
  }
  if(action==="key-view")return parseGroupKeyView(v,scope);
  if(action==="create-state"||action==="member-state"||action==="key-state") {
    const fields=action==="create-state"&&v.state==="applied"?["at","state"]:["at","state","fence"];
    if(!exact(v,fields)||!["absent","applied"].includes(v.state as string)||("fence" in v&&!digest(v.fence)))return fail();
  } else if(action==="create-view") {
    if(!exact(v,["at","context","fence"])||!digest(v.fence)||!exact(v.context,["owner","ownerPub","predicate","setId"])||
        v.context.owner!==objectPrincipal(scope.set)||v.context.predicate!==scope.predicate||v.context.setId!==scope.set||
        typeof v.context.ownerPub!=="string"||!isSeaPubkey(v.context.ownerPub))return fail();
  } else {
    if(!exact(v,["at","draft","signerPub","fence"])||!digest(v.fence)||typeof v.signerPub!=="string"||!isSeaPubkey(v.signerPub)||
        !exact(v.draft,["predicate","set","member","setOwner","role","stated","hamState","issuedAt","cancels"]))return fail();
    const d=v.draft;
    if(d.predicate!==scope.predicate||d.set!==scope.set||d.member!==body.member||d.role!==body.role||d.stated!==body.stated||
        d.setOwner!==objectPrincipal(scope.set)||!integer(d.hamState)||d.issuedAt!==v.at||!Array.isArray(d.cancels)||d.cancels.length>64)return fail();
    let previous="";
    for(const id of d.cancels){if(!digest(id)||id<=previous)return fail();previous=id;}
    if(d.stated===0&&d.cancels.length)return fail();
  }
  return v;
}

export const groupRequestLimit=(action:GroupCommandAction)=>action==="item-grant-view"?2048:action==="item-grant-append"||action==="item-grant-state"?8192:action==="wrap-publish"?92160:action==="key-append"||action==="key-state"?73728:18432;
export const groupResponseLimit=(action:GroupCommandAction)=>action==="wrap-read"?92160:action==="wrap-view"||action==="key-view"||action==="item-authority-view"?73728:18432;
