import { GeneralEncrypt, generalDecrypt } from 'jose';
import { verifyVaultSyncHead, type VaultSyncHead, type VaultHeadIdentityState, type openVaultSyncHeadStore } from 'sociacl-ids/vault-sync';
import type { PrincipalId } from 'sociacl-ids';
import { createVaultStorageClient, type VaultHeadTransport } from './vault-storage-client';
const LIMIT=64*1024,TYPE='sociacl-vault-head+jwe';
/** Local head custody only, not a container-v2 keybag or a slot manager. The
 * caller supplies a dedicated non-exportable AES-KW key from local custody.
 * Lock drops our reference and prevents in-flight plaintext from returning. */
export function createVaultHeadCustody(input:{owner:PrincipalId;vaultId:string;key:CryptoKey;current:VaultHeadIdentityState}){
 const {owner,vaultId,current}=input;
 if(!/^[a-f0-9]{64}$/.test(vaultId)||input.key.type!=='secret'||input.key.extractable||
   input.key.algorithm.name!=='AES-KW'||(input.key.algorithm as AesKeyAlgorithm).length!==256||
   input.key.usages.length!==2||!input.key.usages.includes('wrapKey')||!input.key.usages.includes('unwrapKey'))throw Error('Invalid local vault key');
 let key:CryptoKey|null=input.key;
 const guard=()=>{if(!key)throw Error('Vault locked');return key;};
 function verify(value:unknown){guard();const state=current();const head=verifyVaultSyncHead(value,owner,vaultId,state.rotations,state.context);guard();return head;}
 const protectedHeader={alg:'A256KW',enc:'A256GCM',typ:TYPE,kid:vaultId};
 return Object.freeze({
  lock(){key=null;},
  assertUnlocked(){guard();},
  async seal(head:VaultSyncHead):Promise<Uint8Array>{
   const held=guard(),verified=verify(structuredClone(head));
   const plaintext=new TextEncoder().encode(JSON.stringify(verified));
   try{
    if(plaintext.length>LIMIT)throw Error('Invalid private head');
    const encryptor=new GeneralEncrypt(plaintext).setProtectedHeader(protectedHeader);
    encryptor.addRecipient(held);
    const envelope=await encryptor.encrypt();guard();verify(verified);
    const bytes=new TextEncoder().encode(JSON.stringify(envelope));
    if(bytes.length>LIMIT)throw Error('Invalid private head');return bytes;
   }finally{plaintext.fill(0);}
  },
  async open(inputBytes:Uint8Array):Promise<VaultSyncHead>{
   const held=guard();let plaintext:Uint8Array|undefined;
   try{
    if(!(inputBytes instanceof Uint8Array)||!inputBytes.length||inputBytes.length>LIMIT)throw Error();
    const bytes=new Uint8Array(inputBytes),envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!envelope||Object.keys(envelope).sort().join()!=='ciphertext,iv,protected,recipients,tag'||
      !Array.isArray(envelope.recipients)||envelope.recipients.length!==1||
      !envelope.recipients[0]||Object.keys(envelope.recipients[0]).join()!=='encrypted_key')throw Error();
    const result=await generalDecrypt(envelope,held,{keyManagementAlgorithms:['A256KW'],contentEncryptionAlgorithms:['A256GCM']});
    plaintext=result.plaintext;guard();
    const header=result.protectedHeader;
    if(!header||Object.keys(header).sort().join()!=='alg,enc,kid,typ'||header.alg!=='A256KW'||header.enc!=='A256GCM'||header.typ!==TYPE||header.kid!==vaultId)throw Error();
    return verify(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)));
   }catch{throw Error('Private vault head unavailable');}finally{plaintext?.fill(0);}
  },
 });
}
/** Production composition: callers retain sealed bytes through ambiguous writes.
 * This never derives a key from login, fetches a key, or opens an item. */
export function createSealedVaultStorageClient(input:{owner:PrincipalId;vaultId:string;key:CryptoKey;current:VaultHeadIdentityState;
 transport:VaultHeadTransport;floor:Awaited<ReturnType<typeof openVaultSyncHeadStore>>}){
 const custody=createVaultHeadCustody(input);
 const storage=createVaultStorageClient({...input,current:()=>{custody.assertUnlocked();const state=input.current();custody.assertUnlocked();return state;},openHead:custody.open});
 return Object.freeze({...storage,sealHead:custody.seal,lock:custody.lock});
}
