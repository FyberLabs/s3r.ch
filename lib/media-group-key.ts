import {parseMediaGroupPolicy,type MediaGroupScope} from "./media-group";
import {objectPrincipal} from "./identity/forum-authority-records";
import {isSeaPubkey} from "./identity/forum-check";

const fail=():never=>{throw Error("Group key command unavailable");};
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const signature=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{128}$/.test(v);
const pub=(v:unknown):v is string=>typeof v==="string"&&isSeaPubkey(v);

/** Shape and scope validation only. Native ACL authenticates signatures/history. */
export function parseGroupKeySnapshot(input:unknown,scope:MediaGroupScope) {
  const s=structuredClone(input);
  if(!exact(s,["predicate","setId","setOwner","ownerSigningPub","ownerEncryptionPub","ownerIdentityHead","members"])||
      s.predicate!==scope.predicate||s.setId!==scope.set||s.setOwner!==objectPrincipal(scope.set)||
      !pub(s.ownerSigningPub)||!pub(s.ownerEncryptionPub)||!integer(s.ownerIdentityHead)||!Array.isArray(s.members)||s.members.length>64)return fail();
  let previous="";
  for(const member of s.members){
    if(!exact(member,["accessor","stated","hamState","signingPub","encryptionPub","identityHead"])||
        !pub(member.accessor)||member.accessor<=previous||(member.stated!==0&&member.stated!==1)||
        !integer(member.hamState)||!pub(member.signingPub)||!pub(member.encryptionPub)||!integer(member.identityHead))return fail();
    if(member.accessor===s.setOwner&&(member.signingPub!==s.ownerSigningPub||member.encryptionPub!==s.ownerEncryptionPub||member.identityHead!==s.ownerIdentityHead))return fail();
    previous=member.accessor;
  }
  return s;
}

export function parseGroupKeyCommand(input:unknown,scope:MediaGroupScope) {
  const command=structuredClone(input);
  if(!exact(command,["document","finalization"])||new TextEncoder().encode(JSON.stringify(command)).length>65536||
      !exact(command.document,["manifest","snapshot"]))return fail();
  const m=command.document.manifest,f=command.finalization;
  parseGroupKeySnapshot(command.document.snapshot,scope);
  if(!exact(m,["object","previousEpoch","epoch","deviceId","revisionId","keyCommitment","settleWindowMs","aclSnapshot","signature"])||
      m.object!==scope.set||!integer(m.previousEpoch)||!integer(m.epoch)||m.epoch!==m.previousEpoch+1||
      typeof m.deviceId!=="string"||!/^[\x21-\x7e]{1,128}$/.test(m.deviceId)||
      !digest(m.revisionId)||!digest(m.keyCommitment)||!digest(m.aclSnapshot)||!signature(m.signature)||
      !integer(m.settleWindowMs)||m.settleWindowMs<3600000||m.settleWindowMs>259200000)return fail();
  if(!exact(f,["object","previousEpoch","epoch","revisionId","candidateRevisionIds","previousFinalizationId","finalizationId","signature"])||
      f.object!==scope.set||f.previousEpoch!==m.previousEpoch||f.epoch!==m.epoch||f.revisionId!==m.revisionId||
      !Array.isArray(f.candidateRevisionIds)||f.candidateRevisionIds.length!==1||f.candidateRevisionIds[0]!==m.revisionId||
      (m.previousEpoch===0?f.previousFinalizationId!=="":!digest(f.previousFinalizationId))||
      !digest(f.finalizationId)||!signature(f.signature))return fail();
  return command;
}

export function parseGroupKeyView(input:unknown,scope:MediaGroupScope) {
  const view=structuredClone(input);
  if(!exact(view,["at","fence","snapshot","config","previousEpoch","previousFinalizationId"])||
      !integer(view.at)||!digest(view.fence)||!integer(view.previousEpoch)||view.previousEpoch>=Number.MAX_SAFE_INTEGER||
      (view.previousEpoch===0?view.previousFinalizationId!=="":!digest(view.previousFinalizationId)))return fail();
  parseGroupKeySnapshot(view.snapshot,scope);
  parseMediaGroupPolicy(view.config,scope);
  return view;
}
