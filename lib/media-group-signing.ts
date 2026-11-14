import {signMembershipAssent,signObjectSet,signGroupCancel,membershipSoul,objectSetSoul} from "sociacl-ids/group-signing";
import {parseMediaGroupScope,type MediaGroupScope} from "./media-group";
export type OwnerGroupRowKind="membership"|"object-set"|"cancel";
const fail=():never=>{throw Error("Invalid owner group signing draft");};
/** Flat data-only snapshot before any await; never execute getters or iterators. */
export function snapshotOwnerGroupDraft(input:unknown):Record<string,unknown> {
  if(!input||typeof input!=="object"||Array.isArray(input))return fail();
  const output:Record<string,unknown>={};
  for(const name of Reflect.ownKeys(input)) {
    if(typeof name!=="string"||["sig","attest","issuedAt","predicate","set","__proto__"].includes(name))return fail();
    const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!("value" in d))return fail();
    const value:unknown=d.value;
    if(Array.isArray(value)) {
      const ds=Object.getOwnPropertyDescriptors(value as object),length=ds.length?.value;
      if((name!=="cancels"&&name!=="prior")||!Number.isSafeInteger(length)||length<0||length>64||Reflect.ownKeys(ds).length!==length+1)return fail();
      const copied:string[]=[];
      for(let n=0;n<length;n++){const item=ds[String(n)];if(!item||!("value" in item)||typeof item.value!=="string")return fail();copied.push(item.value);}
      output[name]=copied;
    }else if(typeof value==="string"||typeof value==="number")output[name]=value;
    else return fail();
  }
  return output;
}
/** Current owner key comes from the protected owner view, never this draft. */
export function signOwnerGroupRow(kind:OwnerGroupRowKind,input:Record<string,unknown>,scope:MediaGroupScope,
  object:string,owner:string,at:number,scalar:Uint8Array,currentKey:string) {
  const held=parseMediaGroupScope(scope),draft:Record<string,unknown>={...snapshotOwnerGroupDraft(input),predicate:held.predicate,set:held.set,issuedAt:at};
  if(kind==="membership") {
    if((draft.role==="member"?draft.member:draft.role==="set"?draft.setOwner:null)!==owner)return fail();
    const record=signMembershipAssent(draft,scalar,currentKey);
    return {kind,record,soul:membershipSoul(record.setOwner,record.predicate,record.set,record.member)};
  }
  if(kind==="object-set") {
    if(draft.owner!==owner||draft.object!==object)return fail();
    const record=signObjectSet(draft,scalar,currentKey);
    return {kind,record,soul:objectSetSoul(record.owner,record.object,record.predicate,record.set)};
  }
  if(kind!=="cancel"||draft.signer!==owner||(draft.kind==="object-set"&&draft.object!==object))return fail();
  const record=signGroupCancel(draft,scalar,currentKey);
  return {kind,record,soul:record.rowSoul};
}
