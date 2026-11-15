import { parseMediaGroupScope, type MediaGroupScope } from "./media-group";
import { objectPrincipal } from "./identity/forum-authority-records";
import { isSeaPubkey } from "./identity/forum-check";
import { isCanonicalObjectId } from "./identity/object-id";
import { readBoundedIdentityJson } from "./identity/bounded-json";

const exact=(v:unknown,fields:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join()===fields.sort().join();
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const fail=():never=>{throw Error("Group consent unavailable");};
function cancellations(input:unknown):string[] {
  if(!Array.isArray(input)||input.length>64)return fail();
  let previous="";
  for(const id of input){if(typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id)||id<=previous)return fail();previous=id;}
  return input;
}
function assent(input:unknown) {
  if(input===null)return null;
  if(!exact(input,["stated","hamState","cancels"])||(input.stated!==0&&input.stated!==1)||!integer(input.hamState))return fail();
  return {stated:input.stated,hamState:input.hamState,cancels:cancellations(input.cancels)};
}

/** Protected preparation only. This view neither grants access nor signs consent. */
export function parseMediaGroupConsent(input:unknown,scope:MediaGroupScope,member:string) {
  const held=parseMediaGroupScope(scope),v=structuredClone(input);
  if(!isSeaPubkey(member)||!exact(v,["at","fence","consent"])||!integer(v.at)||typeof v.fence!=="string"||!/^[a-f0-9]{64}$/.test(v.fence)||
      !exact(v.consent,["memberPub","state","draft"])||typeof v.consent.memberPub!=="string"||!isSeaPubkey(v.consent.memberPub))return fail();
  const state=v.consent.state,draft=v.consent.draft,setOwner=objectPrincipal(held.set);
  if(!exact(state,["predicate","set","member","setOwner","memberAssent","setAssent","cancels","stated"])||
      state.predicate!==held.predicate||state.set!==held.set||state.member!==member||state.setOwner!==setOwner)return fail();
  const memberAssent=assent(state.memberAssent),setAssent=assent(state.setAssent),cancels=cancellations(state.cancels);
  if(!setAssent||setAssent.stated!==1||cancels.some(id=>!setAssent.cancels.includes(id)))return fail();
  const live=memberAssent?.stated===1&&cancels.every(id=>memberAssent.cancels.includes(id));
  const hamState=Math.max(memberAssent?.hamState??0,setAssent.hamState)+1;
  if(state.stated!==(live?1:0)||!Number.isSafeInteger(hamState)||
      !exact(draft,["role","predicate","set","member","setOwner","hamState","issuedAt","cancels"])||
      draft.role!=="member"||draft.predicate!==held.predicate||draft.set!==held.set||draft.member!==member||draft.setOwner!==setOwner||
      draft.hamState!==hamState||draft.issuedAt!==v.at||JSON.stringify(cancellations(draft.cancels))!==JSON.stringify(cancels))return fail();
  return {at:v.at,fence:v.fence,consent:{memberPub:v.consent.memberPub,
    state:{...held,member,setOwner:setOwner!,memberAssent,setAssent,cancels,stated:live?1:0},
    draft:{role:"member" as const,...held,member,setOwner:setOwner!,hamState,issuedAt:v.at,cancels:[...cancels]}}};
}

export async function readMediaGroupConsent(object:string,scope:MediaGroupScope,member:string,
  fetcher:typeof fetch=fetch,signal?:AbortSignal,clock=()=>Date.now()/1000) {
  const held=parseMediaGroupScope(scope);
  if(!object.startsWith("media_")||!isCanonicalObjectId(object)||!isSeaPubkey(member))return fail();
  const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
  deadline.throwIfAborted();
  const response=await fetcher("/api/media/group-consent-view",{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({object,...held}),signal:deadline});
  if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
    await response.body?.cancel().catch(()=>{});return fail();
  }
  const value=parseMediaGroupConsent(await readBoundedIdentityJson(response,32768,deadline),held,member);
  deadline.throwIfAborted();
  if(value.at>clock()+1||clock()-value.at>4)return fail();
  return value;
}
