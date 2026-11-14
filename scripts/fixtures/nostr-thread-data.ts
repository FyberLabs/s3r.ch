import {createHash} from "node:crypto";
import {schnorr} from "@noble/curves/secp256k1.js";
import {normalizeNostrEvent} from "../../lib/nostr";
const secret=new Uint8Array(32);secret[31]=7;
const pubkey=Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
export function signedThreadNote(content:string,parent?:string,tags:string[][]=[]){
 const event={pubkey,created_at:123,kind:1,tags:[...(parent?[["e",parent,"","reply"]]:[]),...tags],content};
 const hash=createHash("sha256").update(JSON.stringify([0,event.pubkey,event.created_at,event.kind,event.tags,event.content])).digest();
 return {...event,id:hash.toString("hex"),sig:Buffer.from(schnorr.sign(hash,secret,new Uint8Array(32))).toString("hex")};
}
export const nostrRoot=signedThreadNote("Provider root");
export const nostrParent=signedThreadNote("Provider parent",nostrRoot.id,[["imeta","url https://example.com/parent.png","m image/png","alt Parent photo"]]);
export const nostrChild=signedThreadNote("Public child",nostrParent.id);
export const nostrReply=signedThreadNote("Provider reply",nostrChild.id);
export const nostrEvents=[nostrRoot,nostrParent,nostrChild,nostrReply];
export const nostrAnchor=normalizeNostrEvent(nostrChild,"fixture")!;
