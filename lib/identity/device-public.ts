/** BFF allowlist: public protocol metadata and ciphertext only. Owner packages
 * remain responsible for cryptography, history and authorization validation. */
export const exact=(v:unknown,keys:string):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.split(' ').filter(Boolean).sort().join();
const text=(v:unknown,max=512)=>typeof v==='string'&&v.length>0&&v.length<=max;
export const publicScope=(v:unknown):v is Record<string,string>=>exact(v,'sourceOrigin destinationOrigin application tenant audience')&&Object.values(v).every(s=>text(s));
export const sameScope=(a:unknown,b:unknown)=>publicScope(a)&&publicScope(b)&&Object.keys(a).every(k=>a[k]===b[k]);
export const publicIdentity=(v:unknown)=>exact(v,'principal pub epub rotationSeq')&&['principal','pub','epub'].every(k=>text(v[k],87))&&Number.isSafeInteger(v.rotationSeq)&&v.rotationSeq>=0;
export const publicBinding=(v:unknown,scope:unknown)=>exact(v,'session transcript expiresAt scope identity')&&text(v.session,43)&&text(v.transcript,43)&&Number.isSafeInteger(v.expiresAt)&&sameScope(v.scope,scope)&&publicIdentity(v.identity);
const publicRequest=(v:unknown,scope:unknown,session:string)=>exact(v,'v session receiverKey expiresAt scope')&&v.v===1&&v.session===session&&text(v.receiverKey,87)&&Number.isSafeInteger(v.expiresAt)&&sameScope(v.scope,scope);
export function publicRelayPayload(action:string,v:unknown,scope:unknown,session:string){
 if(action==='admit'||action==='create')return exact(v,action==='admit'?'request joinHash receiverHash':'request joinHash')&&publicRequest(v.request,scope,session)&&text(v.joinHash,43)&&(action!=='admit'||text(v.receiverHash,43));
 if(action==='join')return exact(v,'request senderKey identity payloadHash')&&publicRequest(v.request,scope,session)&&text(v.senderKey,87)&&text(v.payloadHash,43)&&publicIdentity(v.identity);
 if(action==='send')return exact(v,'transcript iv ciphertext')&&text(v.transcript,43)&&text(v.iv,16)&&text(v.ciphertext,700000);
 if(action==='complete')return exact(v,'transcript mac')&&text(v.transcript,43)&&text(v.mac,43);
 return ['offer','receive','completed','cancel'].includes(action)&&exact(v,'');
}
