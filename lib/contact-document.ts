import {isSeaPubkey} from './identity/forum-check';
import type {ResolutionContext} from 'sociacl-ids';
import type {ForumRecoverySnapshot} from './identity/forum-recovery-history';
export type ContactKind='descriptor'|'vault';
export type ContactAction='config'|'read'|'write';
export type ContactConfiguration=Readonly<{at:number;tenant:string;source:string;principal:string;currentKey:string;trust:Pick<ResolutionContext,'jwks'|'policy'> & {pinnedIss:readonly string[]}}>;
export type ContactDocument=Readonly<{at:number;owner:string;kind:ContactKind;revision:number;fence:string;payload:string|null;
  head:{currentKey:string;currentEpub:string;sequence:number;history:ForumRecoverySnapshot}}>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CONTACT_BODY_LIMIT=1400000,CONTACT_RESPONSE_LIMIT=6000000;
const fail=():never=>{throw Error('Contact service unavailable');};
export function contactAction(value:string):value is ContactAction{return ['config','read','write'].includes(value);}
export function parseContactRequest(action:ContactAction,value:unknown,reader:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const body=value as Record<string,unknown>;
  const fields=action==='config'?'evaluatedAt':action==='read'?'evaluatedAt,kind,owner':'evaluatedAt,fence,kind,owner,payload,revision,signature';
  if(Object.keys(body).sort().join()!==fields||!Number.isSafeInteger(body.evaluatedAt)||(body.evaluatedAt as number)<0)return fail();
  if(action==='config')return {...body};
  if(typeof body.owner!=='string'||!isSeaPubkey(body.owner)||!['descriptor','vault'].includes(String(body.kind))||
      ((action==='write'||body.kind==='vault')&&body.owner!==reader))return fail();
  if(action==='write'&&(typeof body.fence!=='string'||!/^[0-9a-f]{64}$/.test(body.fence)||!Number.isSafeInteger(body.revision)||(body.revision as number)<0||(body.revision as number)>=Number.MAX_SAFE_INTEGER||
      typeof body.signature!=='string'||body.signature.length>128||typeof body.payload!=='string'||body.payload.length>1398104))return fail();
  return {...body};
}
export function parseContactResult(action:ContactAction,value:unknown,request:Record<string,unknown>,reader:string,now:number):ContactConfiguration|ContactDocument|{at:number;revision:number;digest:string}{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const v=value as Record<string,unknown>;
  if(v.at!==request.evaluatedAt||v.at!==Math.floor(now))return fail();
  if(action==='config'){
    const c=v as unknown as ContactConfiguration;
    if(Object.keys(v).sort().join()!=='at,currentKey,principal,source,tenant,trust'||c.principal!==reader||!isSeaPubkey(c.currentKey)||
        !uuid.test(c.tenant)||!uuid.test(c.source)||!c.trust||!Array.isArray(c.trust.pinnedIss)||
        !c.trust.jwks||!Array.isArray(c.trust.jwks.keys)||!c.trust.policy)return fail();
    return structuredClone(c);
  }
  if(action==='write'){
    if(Object.keys(v).sort().join()!=='at,digest,revision'||v.revision!==(request.revision as number)+1||typeof v.digest!=='string'||!/^[0-9a-f]{64}$/.test(v.digest))return fail();
    return v as {at:number;revision:number;digest:string};
  }
  const d=v as unknown as ContactDocument;
  if(Object.keys(v).sort().join()!=='at,fence,head,kind,owner,payload,revision'||d.owner!==request.owner||d.kind!==request.kind||
      typeof d.fence!=='string'||!/^[0-9a-f]{64}$/.test(d.fence)||!Number.isSafeInteger(d.revision)||d.revision<0||!d.head||!isSeaPubkey(d.head.currentKey)||!isSeaPubkey(d.head.currentEpub)||
      !Number.isSafeInteger(d.head.sequence)||d.head.sequence<0||!d.head.history||d.head.history.completeThrough!==d.at||
      (d.revision===0?d.payload!==null:typeof d.payload!=='string'||d.payload.length>1398104))return fail();
  return structuredClone(d);
}
