import {signMembershipAssent,membershipSoul} from "sociacl-ids/group-signing";
import {parseMediaGroupScope,parseMediaGroupWriteState,type MediaGroupScope} from "./media-group";
import {readMediaGroupConsent} from "./media-group-consent";
import {parseForumAuthority} from "./identity/forum-authority-records";
import {isCanonicalObjectId} from "./identity/object-id";
import {isSeaPubkey} from "./identity/forum-check";
import {readBoundedIdentityJson} from "./identity/bounded-json";
const fail=():never=>{throw Error("Member consent refused; refresh its protected state");};
const exact=(v:unknown,fields:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join()===fields.sort().join();

/** Transport shape only; the protected source verifies signatures and histories. */
export function parseMemberGroupRow(input:unknown,scope:MediaGroupScope,member:string) {
  const held=parseMediaGroupScope(scope),v=structuredClone(input);
  if(!isSeaPubkey(member)||!exact(v,["kind","soul","record"])||v.kind!=="membership"||typeof v.soul!=="string"||
      !exact(v.record,["role","predicate","set","member","setOwner","stated","hamState","issuedAt","cancels","sig"])||
      v.record.role!=="member"||v.record.member!==member||v.record.predicate!==held.predicate||v.record.set!==held.set||
      typeof v.record.sig!=="string"||!v.record.sig.length||v.record.sig.length>128||new TextEncoder().encode(JSON.stringify(v)).length>8192)return fail();
  const parsed=parseForumAuthority("membership",v.record);
  if(!parsed||parsed.kind!=="membership"||parsed.soul!==v.soul)return fail();
  return {kind:"membership" as const,soul:parsed.soul,record:parsed.row};
}

export function createMediaGroupMember(fetcher:typeof fetch=fetch,clock=()=>Date.now()/1000) {
  const current=(at:number)=>{if(at>clock()+1||clock()-at>4)return fail();};
  const objectOK=(object:string)=>{if(!object.startsWith("media_")||!isCanonicalObjectId(object))return fail();};
  async function request(action:"check"|"append",body:unknown,signal:AbortSignal) {
    const encoded=JSON.stringify(body);if(new TextEncoder().encode(encoded).length>12288)return fail();
    signal.throwIfAborted();
    const response=await fetcher("/api/media/group-consent-"+action,{method:"POST",credentials:"same-origin",redirect:"error",cache:"no-store",
      headers:{"Content-Type":"application/json"},body:encoded,signal});
    if(response.status!==200||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
      await response.body?.cancel().catch(()=>{});return fail();
    }
    const value=await readBoundedIdentityJson(response,4096,signal);signal.throwIfAborted();return value;
  }
  async function check(object:string,scope:MediaGroupScope,row:ReturnType<typeof parseMemberGroupRow>,signal:AbortSignal) {
    const state=parseMediaGroupWriteState(await request("check",{object,...scope,row},signal));current(state.at);return state;
  }
  return Object.freeze({
    async prepare(object:string,scope:MediaGroupScope,member:string,stated:0|1,scalar:Uint8Array,signal?:AbortSignal) {
      objectOK(object);const held=parseMediaGroupScope(scope);
      if((!Object.is(stated,0)&&!Object.is(stated,1))||!(scalar instanceof Uint8Array)||scalar.length!==32)return fail();
      const key=new Uint8Array(scalar),deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
      try {
        deadline.throwIfAborted();
        const view=await readMediaGroupConsent(object,held,member,fetcher,deadline,clock,stated===0);
        const record=signMembershipAssent({...view.consent.draft,stated},key,view.consent.memberPub);
        current(view.at);deadline.throwIfAborted();
        return {kind:"membership" as const,soul:membershipSoul(record.setOwner,record.predicate,record.set,record.member),record};
      } finally {key.fill(0);}
    },
    async state(object:string,scope:MediaGroupScope,member:string,input:unknown,signal?:AbortSignal) {
      objectOK(object);const held=parseMediaGroupScope(scope),row=parseMemberGroupRow(input,held,member);
      const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
      return check(object,held,row,deadline);
    },
    async append(object:string,scope:MediaGroupScope,member:string,input:unknown,signal?:AbortSignal) {
      objectOK(object);const held=parseMediaGroupScope(scope),row=parseMemberGroupRow(input,held,member);
      const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4000)]);
      const state=await check(object,held,row,deadline);
      if(state.state==="applied")return;
      current(state.at);deadline.throwIfAborted();
      if(state.at-row.record.issuedAt<0||state.at-row.record.issuedAt>4)return fail();
      const result=await request("append",{object,...held,row,at:state.at,fence:state.fence},deadline);
      if(!exact(result,["applied"])||result.applied!==true)return fail();
    },
  });
}
