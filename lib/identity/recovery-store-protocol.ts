import {parsePrincipalId} from 'sociacl-ids';
import {exact} from './device-public';
export const recoveryResponseLimit=1100000;
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const principal=(v:unknown)=>typeof v==='string'&&parsePrincipalId(v).ok;
export function recoveryRow(value:any):boolean{
 return exact(value,'principal rotationSeq signingPub epub bytesHex')&&principal(value.principal)&&principal(value.signingPub)&&principal(value.epub)&&integer(value.rotationSeq)&&
  typeof value.bytesHex==='string'&&value.bytesHex.length>=122&&value.bytesHex.length<=1048826&&value.bytesHex.length%2===0&&/^01[0-9a-f]+$/.test(value.bytesHex);
}
export function recoveryPut(value:any):boolean{
 return exact(value,'action row signature')&&value.action==='put'&&recoveryRow(value.row)&&typeof value.signature==='string'&&/^[0-9a-f]{128}$/.test(value.signature);
}
export function recoveryView(value:any):boolean{
 return exact(value,'generation head row')&&integer(value.generation)&&exact(value.head,'sequence currentKey currentEpub')&&integer(value.head.sequence)&&principal(value.head.currentKey)&&
  (value.head.currentEpub===null||principal(value.head.currentEpub))&&(value.row===null||recoveryRow(value.row));
}
export function recoveryGeneration(value:any):boolean{return exact(value,'generation')&&integer(value.generation);}
