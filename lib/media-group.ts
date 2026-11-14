import { isCanonicalObjectId } from "./identity/object-id";
import { objectPrincipal } from "./identity/forum-authority-records";
import { isSeaPubkey } from "./identity/forum-check";

const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const predicate=(v:unknown):v is "same-group"|"named-circle"=>v==="same-group"||v==="named-circle";
const setId=(v:unknown):v is string=>typeof v==="string"&&v.startsWith("set_")&&isCanonicalObjectId(v);
const fail=():never=>{throw Error("Invalid protected media group");};
type Member={accessor:string;predicate:"same-group"|"named-circle";setId:string;stated:0|1;hamState:number};
type Edge=Omit<Member,"accessor">;
export type MediaGroupView={at:number;fence:string;objectVersion:number;projection:null|{
  object:string;set:string|null;predicate:"same-group"|"named-circle"|null;members:string[];
  snapshot:null|{members:Member[];objectSet:Edge}}};

/** A protected projection is context for owner actions, never a delivery grant. */
export function parseMediaGroupView(input:unknown,object:string):MediaGroupView {
  const v=structuredClone(input),owner=objectPrincipal(object);
  if(!object.startsWith("media_")||!isCanonicalObjectId(object)||!owner||
      !exact(v,["at","fence","objectVersion","projection"])||!integer(v.at)||!integer(v.objectVersion)||
      typeof v.fence!=="string"||!/^[a-f0-9]{64}$/.test(v.fence))return fail();
  const p=v.projection;
  if(p===null)return v as MediaGroupView;
  if(!exact(p,["object","set","predicate","members","snapshot"])||p.object!==object||!Array.isArray(p.members)||p.members.length>64)return fail();
  if(p.snapshot===null) {
    if(p.set!==null||p.predicate!==null||p.members.length)return fail();
    return v as MediaGroupView;
  }
  if(!setId(p.set)||!predicate(p.predicate)||!exact(p.snapshot,["members","objectSet"])||
      !Array.isArray(p.snapshot.members)||p.snapshot.members.length>64)return fail();
  const edge=p.snapshot.objectSet;
  if(!exact(edge,["predicate","setId","stated","hamState"])||edge.predicate!==p.predicate||edge.setId!==p.set||
      (edge.stated!==0&&edge.stated!==1)||!integer(edge.hamState))return fail();
  let previous="";const active:string[]=[];
  for(const m of p.snapshot.members) {
    if(!exact(m,["accessor","predicate","setId","stated","hamState"])||typeof m.accessor!=="string"||!isSeaPubkey(m.accessor)||
        m.accessor<=previous||m.predicate!==p.predicate||m.setId!==p.set||(m.stated!==0&&m.stated!==1)||!integer(m.hamState))return fail();
    previous=m.accessor;
    if(edge.stated===1&&m.stated===1&&m.accessor!==owner)active.push(m.accessor);
  }
  if(JSON.stringify(p.members)!==JSON.stringify(active))return fail();
  return v as MediaGroupView;
}

/** Detach already signed rows before awaiting a fresh fence. Native admission
 * remains responsible for signatures, current histories and canonical souls. */
export function parseMediaGroupAppend(input:unknown) {
  const v=structuredClone(input);
  if(!exact(v,["predicate","set","rows"])||!predicate(v.predicate)||!setId(v.set)||
      !Array.isArray(v.rows)||v.rows.length<1||v.rows.length>64||new TextEncoder().encode(JSON.stringify(v.rows)).length>65536)return fail();
  for(const row of v.rows)if(!exact(row,["kind","record","soul"])||!["object","membership","object-set","cancel"].includes(row.kind as string)||
      typeof row.soul!=="string"||!row.soul.length||!row.record||typeof row.record!=="object"||Array.isArray(row.record))return fail();
  return {predicate:v.predicate,set:v.set,rows:v.rows};
}
