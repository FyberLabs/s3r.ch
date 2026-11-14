import { isSeaPubkey } from "./identity/forum-check";
import { isCanonicalObjectId } from "./identity/object-id";
import type { PrivateMediaDeletion } from "sociacl-ids/private-media";

const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join();
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
export type MediaDeletionIntent=Readonly<{tenant:string;object:string;owner:string;ownerPub:string;at:number;proof:Readonly<{deletionBytes:string;signature:string}>}>;

export function parseMediaDeletionDraft(value:unknown,tenant:string,object:string,owner:string) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)||tenant==="00000000-0000-0000-0000-000000000000"||
      !object.startsWith("media_")||!isCanonicalObjectId(object)||!isSeaPubkey(owner)||
      !exact(value,["at","ownerPub","claims"])||!integer(value.at)||typeof value.ownerPub!=="string"||!isSeaPubkey(value.ownerPub)||
      !exact(value.claims,["tenant","object","owner","objectVersion","fence","issuedAt","expiresAt"]))throw Error("Invalid media deletion draft");
  const c=value.claims;
  if(c.tenant!==tenant||c.object!==object||c.owner!==owner||!integer(c.objectVersion)||typeof c.fence!=="string"||!/^[0-9a-f]{64}$/.test(c.fence)||
      !integer(c.issuedAt)||c.issuedAt!==value.at*1000||!integer(c.expiresAt)||c.expiresAt<=c.issuedAt||c.expiresAt-c.issuedAt>60000)throw Error("Invalid media deletion binding");
  return {at:value.at,ownerPub:value.ownerPub,claims:c as unknown as PrivateMediaDeletion};
}

/** Public signed intent only. Retrying it never generates a new owner signature. */
export function parseMediaDeletionIntent(input:unknown):MediaDeletionIntent {
  if(!exact(input,["tenant","object","owner","ownerPub","at","proof"])||typeof input.tenant!=="string"||typeof input.object!=="string"||typeof input.owner!=="string"||
      !exact(input.proof,["deletionBytes","signature"])||typeof input.proof.deletionBytes!=="string"||input.proof.deletionBytes.length>4096||!/^(?:[0-9a-f]{2})+$/.test(input.proof.deletionBytes)||
      typeof input.proof.signature!=="string"||!/^[0-9a-f]{128}$/.test(input.proof.signature))throw Error("Invalid media deletion intent");
  const bytes=Uint8Array.from(input.proof.deletionBytes.match(/../g)!,v=>parseInt(v,16));
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),prefix="SOCIACL_PRIVATE_MEDIA_DELETE_V1\n";
  if(!text.startsWith(prefix))throw Error("Invalid media deletion domain");
  const fields=JSON.parse(text.slice(prefix.length));
  if(!Array.isArray(fields)||fields.length!==7||text!==prefix+JSON.stringify(fields))throw Error("Invalid media deletion transcript");
  const [tenant,object,owner,objectVersion,fence,issuedAt,expiresAt]=fields;
  const draft=parseMediaDeletionDraft({at:input.at,ownerPub:input.ownerPub,claims:{tenant,object,owner,objectVersion,fence,issuedAt,expiresAt}},input.tenant,input.object,input.owner);
  return Object.freeze({tenant:input.tenant,object:input.object,owner:input.owner,ownerPub:draft.ownerPub,at:draft.at,
    proof:Object.freeze({deletionBytes:input.proof.deletionBytes,signature:input.proof.signature})});
}
