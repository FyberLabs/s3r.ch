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

export type MediaGroupScope={predicate:"same-group"|"named-circle";set:string};
export type MediaGroupPolicy={owner:string;setId:string;predicate:"same-group"|"named-circle";settleWindowMs:number;configRevision:number;signature:string};
export function parseMediaGroupScope(input:unknown):MediaGroupScope {
  const v=structuredClone(input);
  if(!exact(v,["predicate","set"])||!predicate(v.predicate)||!setId(v.set))return fail();
  return v as MediaGroupScope;
}
export function parseMediaGroupPolicy(input:unknown,scope:MediaGroupScope):MediaGroupPolicy {
  const v=structuredClone(input),held=parseMediaGroupScope(scope);
  if(!exact(v,["owner","setId","predicate","settleWindowMs","configRevision","signature"])||v.owner!==objectPrincipal(held.set)||
      v.setId!==held.set||v.predicate!==held.predicate||!integer(v.configRevision)||!integer(v.settleWindowMs)||
      v.settleWindowMs<3600000||v.settleWindowMs>259200000||typeof v.signature!=="string"||!/^[a-f0-9]{128}$/.test(v.signature))return fail();
  return v as MediaGroupPolicy;
}
export function parseMediaGroupPolicyView(input:unknown,scope:MediaGroupScope) {
  const v=structuredClone(input),held=parseMediaGroupScope(scope);
  if(!exact(v,["at","fence","context","config"])||!integer(v.at)||typeof v.fence!=="string"||!/^[a-f0-9]{64}$/.test(v.fence)||
      !exact(v.context,["owner","ownerPub","setId","predicate"])||v.context.owner!==objectPrincipal(held.set)||
      v.context.setId!==held.set||v.context.predicate!==held.predicate||typeof v.context.ownerPub!=="string"||!isSeaPubkey(v.context.ownerPub))return fail();
  const config=v.config===null?null:parseMediaGroupPolicy(v.config,held);
  return {at:v.at,fence:v.fence,context:{owner:v.context.owner as string,ownerPub:v.context.ownerPub,setId:held.set,predicate:held.predicate},config};
}

/** Atomic preparation input. Direct grants stay distinct from group membership. */
export function parseMediaGroupAuthority(input:unknown,object:string,owner:string) {
  const v=structuredClone(input);
  if(!exact(v,["at","fence","objectVersion","projection","direct","policy","owner","bindings"])||
      v.owner!==owner||owner!==objectPrincipal(object)||!exact(v.direct,["entries"])||
      !Array.isArray(v.direct.entries)||v.direct.entries.length>64||!v.bindings||typeof v.bindings!=="object"||Array.isArray(v.bindings))return fail();
  const held=parseMediaGroupView({at:v.at,fence:v.fence,objectVersion:v.objectVersion,projection:v.projection},object);
  const named=new Set([owner]);let previous="";
  for(const e of v.direct.entries) {
    if(!exact(e,["accessor","grantRevision","stated","from","until","scope","setId","hamState"])||
        typeof e.accessor!=="string"||!isSeaPubkey(e.accessor)||e.accessor<=previous||!integer(e.grantRevision)||e.grantRevision<1||
        (e.stated!==0&&e.stated!==1)||!integer(e.from)||!integer(e.until)||e.until<=e.from||
        e.scope!=="direct"||e.setId!==""||e.hamState!==0)return fail();
    previous=e.accessor;named.add(e.accessor);
  }
  let policy:ReturnType<typeof parseMediaGroupPolicyView>|null=null;
  if(held.projection?.snapshot) {
    const edge=held.projection.snapshot.objectSet;
    if(!exact(v.policy,["context","config"]))return fail();
    policy=parseMediaGroupPolicyView({at:v.at,fence:v.fence,...v.policy},{predicate:edge.predicate,set:edge.setId});
    named.add(policy.context.owner);
    for(const member of held.projection.snapshot.members)named.add(member.accessor);
  }else if(v.policy!==null)return fail();
  const bindings=v.bindings as Record<string,unknown>;
  if(Object.keys(bindings).length!==named.size)return fail();
  for(const who of named) {
    const b=bindings[who];
    if(!exact(b,["pub","epub","head"])||typeof b.pub!=="string"||!isSeaPubkey(b.pub)||
        typeof b.epub!=="string"||!isSeaPubkey(b.epub)||!integer(b.head))return fail();
  }
  if(policy&&(bindings[policy.context.owner] as {pub:string}).pub!==policy.context.ownerPub)return fail();
  return {...held,owner,direct:v.direct,policy:policy?{context:policy.context,config:policy.config}:null,
    bindings:bindings as Record<string,{pub:string;epub:string;head:number}>};
}
