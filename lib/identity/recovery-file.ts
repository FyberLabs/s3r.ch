import {base64UrlToBytes,bytesToBase64Url} from './wrap';
import {recoveryRow} from './recovery-store-protocol';
import type {RecoveryRow} from './recovery-store-save';
export function recoveryFileRow(file:Uint8Array):RecoveryRow{
 if(!file.length||file.length>710000)throw Error('Recovery file unavailable');
 const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(file));
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='ciphertext,epub,principal,rotationSeq,signingPub,version'||value.version!==1||typeof value.ciphertext!=='string'||value.ciphertext.length>700000)throw Error('Recovery file unavailable');
 const bytes=base64UrlToBytes(value.ciphertext);
 if(bytesToBase64Url(bytes)!==value.ciphertext)throw Error('Recovery file unavailable');
 const row={principal:value.principal,rotationSeq:value.rotationSeq,signingPub:value.signingPub,epub:value.epub,bytesHex:Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')};
 if(!recoveryRow(row))throw Error('Recovery file unavailable');return row;
}
export function recoveryRowEnvelope(row:RecoveryRow){
 if(!recoveryRow(row))throw Error('Recovery row unavailable');
 return {principal:row.principal,rotationSeq:row.rotationSeq,signingPub:row.signingPub,epub:row.epub,bytes:Uint8Array.from(row.bytesHex.match(/../g)!,h=>parseInt(h,16))};
}
export function recoveryRowFile(row:RecoveryRow):Uint8Array{
 const {bytes,...meta}=recoveryRowEnvelope(row);
 return new TextEncoder().encode(JSON.stringify({version:1,...meta,ciphertext:bytesToBase64Url(bytes)}));
}
