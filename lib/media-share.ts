import { isSeaPubkey } from "./identity/forum-check";
import { isCanonicalObjectId } from "./identity/object-id";

const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const pub=(v:unknown):v is string=>typeof v==="string"&&isSeaPubkey(v);
export type ShareGrant={object:string;owner:string;accessor:string;from:number;until:number;stated:1;epoch:number;grantRevision:number;itemCiphertextDigest:string};

/** Parse before signing or returning any protected recipient data. */
export function parseMediaSharePlan(input:unknown,object:string,owner:string,reader:string) {
  const v=structuredClone(input);
  if(!object.startsWith("media_")||!isCanonicalObjectId(object)||!pub(owner)||!pub(reader)||reader===owner||
      !exact(v,["at","fence","owner","ownerPub","reader","previousEpoch","previousFinalizationId","grants","snapshot","bindings"])||
      !integer(v.at)||!Number.isSafeInteger(v.at*1000)||!digest(v.fence)||v.owner!==owner||v.reader!==reader||!pub(v.ownerPub)||
      !integer(v.previousEpoch)||v.previousEpoch<1||v.previousEpoch>=Number.MAX_SAFE_INTEGER||!digest(v.previousFinalizationId)||
      !Array.isArray(v.grants)||v.grants.length<2||v.grants.length>64||!exact(v.snapshot,["entries"])||
      !Array.isArray(v.snapshot.entries)||v.snapshot.entries.length>64||!v.bindings||typeof v.bindings!=="object"||Array.isArray(v.bindings))
    throw Error("Invalid protected share plan");
  const bindings=v.bindings as Record<string,unknown>, grants:ShareGrant[]=[], seen=new Set<string>();
  for(const g of v.grants) {
    if(!exact(g,["object","owner","accessor","from","until","stated","epoch","grantRevision","itemCiphertextDigest"])||
        g.object!==object||g.owner!==owner||!pub(g.accessor)||seen.has(g.accessor)||!integer(g.from)||!integer(g.until)||
        g.until<=g.from||g.until<=v.at*1000||g.stated!==1||g.epoch!==v.previousEpoch+1||!integer(g.grantRevision)||g.grantRevision<1||!digest(g.itemCiphertextDigest))
      throw Error("Invalid share grant");
    const b=bindings[g.accessor];
    if(!exact(b,["pub","epub","head"])||!pub(b.pub)||!pub(b.epub)||!integer(b.head))throw Error("Invalid share recipient key");
    seen.add(g.accessor);grants.push(g as ShareGrant);
  }
  if(!seen.has(owner)||!seen.has(reader)||Object.keys(bindings).length!==seen.size||
      (bindings[owner] as {pub:string}).pub!==v.ownerPub||new Set(grants.map(g=>g.itemCiphertextDigest)).size!==1)
    throw Error("Invalid share participants");
  const entries=new Map<string,Record<string,unknown>>();
  for(const e of v.snapshot.entries) {
    if(!exact(e,["accessor","grantRevision","stated","from","until","scope","setId","hamState"])||!pub(e.accessor)||entries.has(e.accessor)||
        !integer(e.grantRevision)||e.grantRevision<1||![0,1].includes(e.stated as number)||!integer(e.from)||!integer(e.until)||e.until<=e.from||
        e.scope!=="direct"||e.setId!==""||e.hamState!==0)throw Error("Invalid share snapshot");
    if(e.stated===1&&e.until>v.at*1000&&!seen.has(e.accessor))throw Error("Omitted share recipient");
    entries.set(e.accessor,e);
  }
  for(const g of grants) {
    const e=entries.get(g.accessor);
    if(!e||e.grantRevision!==g.grantRevision||e.stated!==1||e.from!==g.from||e.until!==g.until)throw Error("Share snapshot mismatch");
  }
  return {at:v.at,fence:v.fence,owner,ownerPub:v.ownerPub,reader,previousEpoch:v.previousEpoch,
    previousFinalizationId:v.previousFinalizationId,grants,snapshot:v.snapshot,
    bindings:bindings as Record<string,{pub:string;epub:string;head:number}>};
}
