import {isSeaPubkey} from "./identity/forum-check";
import {isCanonicalObjectId} from "./identity/object-id";
import {objectPrincipal} from "./identity/forum-authority-records";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
import {parseItemGrantClaims} from "./media-group-item-grant";

const fail=():never=>{throw Error("Group item epoch unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const pub=(v:unknown):v is string=>typeof v==="string"&&isSeaPubkey(v);

/** Validate protected metadata before signing. This does not authorize key delivery. */
export function parseGroupItemEpochPlan(input:unknown,object:string,owner:string,scope:MediaGroupScope,now:number) {
  parseMediaGroupScope(scope);
  const v=structuredClone(input);
  if(!pub(owner)||!isCanonicalObjectId(object)||!object.startsWith("media_")||objectPrincipal(object)!==owner||
      !Number.isFinite(now)||!exact(v,["at","fence","owner","ownerPub","predicate","set","previousEpoch","previousFinalizationId",
        "settleWindowMs","grants","snapshot","bindings","groupReaders","keyCommitment"])||
      !integer(v.at)||!Number.isSafeInteger(v.at*1000)||v.at>now+1||now-v.at>4||!digest(v.fence)||
      v.owner!==owner||!pub(v.ownerPub)||v.predicate!==scope.predicate||v.set!==scope.set||
      !integer(v.previousEpoch)||v.previousEpoch<1||v.previousEpoch>=Number.MAX_SAFE_INTEGER||!digest(v.previousFinalizationId)||
      !integer(v.settleWindowMs)||v.settleWindowMs<3600000||v.settleWindowMs>259200000||!Number.isSafeInteger(v.at*1000+v.settleWindowMs)||!digest(v.keyCommitment)||
      !Array.isArray(v.grants)||v.grants.length<1||v.grants.length>64||!Array.isArray(v.groupReaders)||v.groupReaders.length>64||
      !exact(v.snapshot,["entries","objectSet"])||!Array.isArray(v.snapshot.entries)||v.snapshot.entries.length>64||
      !v.bindings||typeof v.bindings!=="object"||Array.isArray(v.bindings))return fail();
  const edge=v.snapshot.objectSet;
  if(!exact(edge,["predicate","setId","stated","hamState"])||edge.predicate!==scope.predicate||edge.setId!==scope.set||
      (edge.stated!==0&&edge.stated!==1)||!integer(edge.hamState))return fail();
  const bindings=v.bindings as Record<string,unknown>,active=new Set<string>(),drafts=new Map<string,ReturnType<typeof parseItemGrantClaims>>();
  let prior="",itemDigest="";
  for(const input of v.grants){
    const g=parseItemGrantClaims(input,object,owner);
    if(g.accessor<=prior||g.epoch!==v.previousEpoch+1||(itemDigest&&itemDigest!==g.itemCiphertextDigest))return fail();
    prior=g.accessor;itemDigest=g.itemCiphertextDigest;drafts.set(g.accessor,g);
    if(g.stated===1){
      const b=bindings[g.accessor];
      if(g.from>v.at*1000||g.until<=v.at*1000+v.settleWindowMs||!exact(b,["pub","epub","head"])||!pub(b.pub)||!pub(b.epub)||!integer(b.head))return fail();
      active.add(g.accessor);
    }
  }
  if(!active.has(owner)||Object.keys(bindings).length!==active.size||
      (bindings[owner] as {pub:string}).pub!==v.ownerPub)return fail();
  const groupReaders=new Set<string>();prior="";
  for(const reader of v.groupReaders){if(!pub(reader)||reader<=prior||active.has(reader)||edge.stated!==1)return fail();groupReaders.add(reader);prior=reader;}
  const seen=new Set<string>(),seenGroups=new Set<string>();prior="";
  for(const e of v.snapshot.entries){
    if(!exact(e,["accessor","grantRevision","stated","from","until","scope","setId","hamState"])||!pub(e.accessor)||e.accessor<=prior||
        !integer(e.grantRevision)||e.grantRevision<1||(e.stated!==0&&e.stated!==1)||!integer(e.from)||!integer(e.until)||e.until<=e.from||!integer(e.hamState))return fail();
    prior=e.accessor;seen.add(e.accessor);
    const g=drafts.get(e.accessor);
    if(e.scope==="direct"){
      if(e.setId!==""||e.hamState!==0||(!g&&e.stated!==0)||
          (g&&(g.grantRevision!==e.grantRevision||g.stated!==e.stated||g.from!==e.from||g.until!==e.until)))return fail();
    }else{
      if(g?.stated===1||e.scope!==scope.predicate||e.setId!==scope.set||
          (e.stated===1&&(!groupReaders.has(e.accessor)||e.from>v.at*1000||e.until<=v.at*1000+v.settleWindowMs))||
          (e.stated===0&&groupReaders.has(e.accessor)))return fail();
      if(e.stated===1)seenGroups.add(e.accessor);
    }
  }
  if([...drafts.keys()].some(who=>!seen.has(who))||seenGroups.size!==groupReaders.size)return fail();
  return v;
}
