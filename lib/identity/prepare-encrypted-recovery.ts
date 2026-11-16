import {sealRecoveryKeyring,RecoveryWeakPassphraseError} from 'sociacl-ids/recovery';
import {importKeyring,closeKeyring,type KeyringIdentity,type KeyringState} from 'sociacl-ids/keyring';
import {bytesToBase64Url} from './wrap';
/** A local downloadable copy, with no publication, replacement or key rotation. */
export async function prepareEncryptedRecovery(material:Uint8Array,identity:KeyringIdentity,passphrase:Uint8Array,accountHandle:string,input:{
 current:()=>boolean;signal:AbortSignal;keyringState:(identity:KeyringIdentity)=>Promise<KeyringState>;
}):Promise<Uint8Array>{
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error();};
 let phrase:Uint8Array|undefined,plain:Uint8Array|undefined,handle:ReturnType<typeof importKeyring>|undefined;
 try{
  guard();if(!material.length||material.length>524288||!passphrase.length||typeof accountHandle!=='string'||accountHandle.length>255)throw Error();
  phrase=new Uint8Array(passphrase);plain=new Uint8Array(material);const owner={...identity};
  const currentState=await input.keyringState(owner);guard();
  const state=()=>{guard();return currentState();};
  handle=importKeyring(plain,owner,state);
  const sealed=await sealRecoveryKeyring(handle,phrase,state,input.signal,accountHandle);guard();
  return new TextEncoder().encode(JSON.stringify({version:1,principal:sealed.principal,signingPub:sealed.signingPub,epub:sealed.epub,rotationSeq:sealed.rotationSeq,ciphertext:bytesToBase64Url(sealed.bytes)}));
 }catch(error){if(error instanceof RecoveryWeakPassphraseError)throw error;throw Error('Recovery copy unavailable');}
 finally{phrase?.fill(0);plain?.fill(0);if(handle)closeKeyring(handle);}
}
