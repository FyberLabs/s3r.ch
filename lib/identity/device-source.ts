import {admitKeyring,exportKeyring,closeKeyring,type KeyringMaterial,type KeyringState} from 'sociacl-ids/keyring';
import type {Identity} from 'sea-device-link';
import type {SeaPair} from './sea';
/** Public identity claims are untrusted until the transfer owner and SociACL
 * validate them. Source selection never depends on an unrelated contacts API. */
export async function exportDeviceSource(material:KeyringMaterial,pair:SeaPair,input:{current:()=>boolean;keyringState:(identity:Identity)=>Promise<KeyringState>}){
 const guard=()=>{if(!input.current())throw Error('Identity changed');};guard();
 if(!material||material.pub!==pair.pub||material.epub!==pair.epub||material.priv!==pair.priv||material.epriv!==pair.epriv||typeof material.principal!=='string'||!Number.isSafeInteger(material.rotationSeq))throw Error('Complete keyring required');
 const snapshot=structuredClone(material),identity={principal:snapshot.principal,pub:pair.pub,epub:pair.epub,rotationSeq:snapshot.rotationSeq};
 const state=await input.keyringState(identity);guard();const handle=admitKeyring(snapshot,identity,state);
 try{return {identity,keyring:exportKeyring(handle,state)};}finally{closeKeyring(handle);}
}
