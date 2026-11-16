import {openRecoveryKeyring} from 'sociacl-ids/recovery';
import {exportKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {restoreCanonicalKeyring,type RestoreKeyringInput} from './restore-keyring';
import {base64UrlToBytes,bytesToBase64Url} from './wrap';
/** Transport JSON wraps canonical owner ciphertext; it defines no crypto format.
 * Passphrase and decrypted keyring never enter an HTTP request or error message. */
export async function restoreEncryptedRecovery(file:Uint8Array,passphrase:Uint8Array,input:RestoreKeyringInput){
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error('Identity context changed');};guard();
 let secret:Uint8Array|undefined,canonical:Uint8Array|undefined,handle:Awaited<ReturnType<typeof openRecoveryKeyring>>|undefined;
 try{
  if(!file.length||file.length>710000||!passphrase.length)throw Error();
  secret=new Uint8Array(passphrase);
  const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(file));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='ciphertext,epub,principal,rotationSeq,signingPub,version'||value.version!==1||typeof value.ciphertext!=='string'||value.ciphertext.length>700000)throw Error();
  const identity={principal:value.principal,pub:value.signingPub,epub:value.epub,rotationSeq:value.rotationSeq};
  if(![identity.principal,identity.pub,identity.epub].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(v))||!Number.isSafeInteger(identity.rotationSeq)||identity.rotationSeq<0)throw Error();
  const bytes=base64UrlToBytes(value.ciphertext);
  if(bytes.length>524413||bytesToBase64Url(bytes)!==value.ciphertext)throw Error();
  const state=await input.keyringState(identity);guard();
  handle=await openRecoveryKeyring(secret,{principal:identity.principal,signingPub:identity.pub,epub:identity.epub,rotationSeq:identity.rotationSeq,bytes},identity,()=>{guard();return state();},input.signal);guard();
  canonical=exportKeyring(handle,state);
  return await restoreCanonicalKeyring(canonical,identity,input);
 }catch{throw Error('Encrypted recovery unavailable');}
 finally{secret?.fill(0);canonical?.fill(0);if(handle)closeKeyring(handle);}
}
