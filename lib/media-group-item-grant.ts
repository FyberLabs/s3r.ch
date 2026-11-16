import {isSeaPubkey} from "./identity/forum-check";
import {isCanonicalObjectId} from "./identity/object-id";
import {objectPrincipal} from "./identity/forum-authority-records";
import {parseMediaGroupScope} from "./media-group";

export type ItemGrantAction="item-grant-view"|"item-grant-append"|"item-grant-state";
export type ItemGrantClaims={object:string;accessor:string;from:number;until:number;stated:0|1;epoch:number;owner:string;grantRevision:number;itemCiphertextDigest:string};
export type ItemGrantPayload={claims:ItemGrantClaims;proof:{grantBytes:string;signature:string}};
export type ItemGrantState={at:number;state:"applied"|"absent";frozen:boolean};
const fail=():never=>{throw Error("Group item grant unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
export function parseItemGrantClaims(value:unknown,object:string,owner:string):ItemGrantClaims {
  if(!exact(value,["object","accessor","from","until","stated","epoch","owner","grantRevision","itemCiphertextDigest"])||
    value.object!==object||value.owner!==owner||typeof value.accessor!=="string"||!isSeaPubkey(value.accessor)||
    !integer(value.from)||!integer(value.until)||value.until<=value.from||(value.stated!==0&&value.stated!==1)||
    !integer(value.epoch)||value.epoch<1||!integer(value.grantRevision)||value.grantRevision<1||!digest(value.itemCiphertextDigest))return fail();
  return structuredClone(value) as ItemGrantClaims;
}
export function parseItemGrantCommand(action:ItemGrantAction,input:unknown,principal:string):Record<string,unknown> {
  const v=structuredClone(input),fields=action==="item-grant-view"?["object","predicate","set","reader","withdraw"]:
    action==="item-grant-append"?["object","predicate","set","at","fence","payload"]:["object","predicate","set","payload"];
  if(!isSeaPubkey(principal)||!exact(v,fields)||typeof v.object!=="string"||!v.object.startsWith("media_")||
    !isCanonicalObjectId(v.object)||objectPrincipal(v.object)!==principal)return fail();
  parseMediaGroupScope({predicate:v.predicate,set:v.set});
  if(action==="item-grant-view") {
    if(typeof v.reader!=="string"||!isSeaPubkey(v.reader)||typeof v.withdraw!=="boolean")return fail();
  } else {
    if(!exact(v.payload,["claims","proof"]))return fail();
    parseItemGrantClaims(v.payload.claims,v.object,principal);
    const proof=v.payload.proof;
    if(!exact(proof,["grantBytes","signature"])||typeof proof.grantBytes!=="string"||!/^([a-f0-9]{2})+$/.test(proof.grantBytes)||
      typeof proof.signature!=="string"||! /^[a-f0-9]{128}$/.test(proof.signature)||new TextEncoder().encode(JSON.stringify(v.payload)).length>4096)return fail();
    if(action==="item-grant-append"&&(!integer(v.at)||!digest(v.fence)))return fail();
  }
  return v;
}
export function parseItemGrantResult(action:ItemGrantAction,input:unknown,body:Record<string,unknown>,now:number,principal:string):Record<string,unknown> {
  const v=structuredClone(input);
  if(action==="item-grant-append") {
    if(!exact(v,["accepted"])||v.accepted!==true)return fail();return v;
  }
  if(!exact(v,action==="item-grant-view"?["at","fence","ownerPub","grant"]:["at","state","frozen"])||
    !Number.isFinite(now)||!integer(v.at)||v.at>now+1||now-v.at>4)return fail();
  if(action==="item-grant-state") {
    if(!["applied","absent"].includes(v.state as string)||typeof v.frozen!=="boolean")return fail();
  } else {
    if(!digest(v.fence)||typeof v.ownerPub!=="string"||!isSeaPubkey(v.ownerPub))return fail();
    const grant=parseItemGrantClaims(v.grant,body.object as string,principal);
    if(grant.accessor!==body.reader||grant.stated!==(body.withdraw?0:1)||(!body.withdraw&&grant.from!==v.at*1000))return fail();
  }
  return v;
}
