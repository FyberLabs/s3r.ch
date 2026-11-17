/** Public transport shapes only. ACL owns authorization and history validation. */
import {parsePrincipalId,signingBytes} from 'sociacl-ids';
import {exact} from './device-public';
const point=(v:unknown)=>typeof v==='string'&&parsePrincipalId(v).ok;
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export function walletRotation(value:any,attested=false):boolean{
 try{
  if(!exact(value,'v kind principal seq prevKey nextKey nextEpub issuedAt retainedLinks authorizer nextSig'+(attested?' attest':''))||
   !exact(value.authorizer,'kind link siwe')||value.authorizer.kind!=='wallet'||!exact(value.authorizer.siwe,'message signature')||
   typeof value.authorizer.siwe.message!=='string'||value.authorizer.siwe.message.length>8192||
   typeof value.authorizer.siwe.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(value.authorizer.siwe.signature)||
   !point(value.nextEpub)||typeof value.nextSig!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(value.nextSig))return false;
  if(attested&&!(typeof value.attest==='string'&&value.attest.length>0&&value.attest.length<=16384))return false;
  return signingBytes(value).ok;
 }catch{return false;}
}
export function rotationAttestation(value:any):boolean{return exact(value,'attest')&&typeof value.attest==='string'&&value.attest.length>0&&value.attest.length<=16384;}
export function rotationPublished(value:any):boolean{return exact(value,'recordHash')&&hash(value.recordHash);}
export function rotationState(value:any):boolean{return exact(value,'recordHash present head')&&hash(value.recordHash)&&typeof value.present==='boolean'&&
 exact(value.head,'sequence currentKey currentEpub')&&integer(value.head.sequence)&&point(value.head.currentKey)&&point(value.head.currentEpub);}
export function recoveryCommit(value:any):boolean{return exact(value,'action signature')&&value.action==='commit'&&typeof value.signature==='string'&&/^[0-9a-f]{128}$/.test(value.signature);}
