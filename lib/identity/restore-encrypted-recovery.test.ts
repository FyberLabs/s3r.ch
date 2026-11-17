import {importKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {sealRecoveryKeyring} from 'sociacl-ids/recovery';
import {openMeshDb,MESH_STORE_NAME} from './idb';
// Native recovery, crypto and IndexedDB contracts run only in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {historyState} from 'sociacl-ids';
import {restoreEncryptedRecovery,replaceRotatedEncryptedRecovery} from './restore-encrypted-recovery';
import {restoredKeyringRecords} from './restored-keyring-storage';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL('../.pairing-test-vectors/'+name+'.json',import.meta.url),'utf8'));
async function setup(){
 const ring=fixture('account-keyring'),records=fixture('records'),legacy=fixture('recovery-legacy-strength'),g=ring.genesis;
 const factory=new IDBFactory(),abort=new AbortController();let active=true,reads=0,protects=0,refuse=false;
 const identity={principal:g.principal,pub:g.signingPub,epub:g.epub,rotationSeq:0};
 const state=():any=>{if(refuse)throw Error();return {rotations:[],context:{...records.context,links:new Map(records.context.links),revocations:[],pinnedIss:new Set(records.context.pinnedIss),genesisEpubBindings:[ring.genesisBinding],history:(p:any,at:number,until:number)=>records.context.authenticatedAccounts.includes(p)?{ok:true,value:historyState(p,[],at,until)}:{ok:false,reason:'missing-history'}}};};
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const input={factory,signal:abort.signal,current:()=>active,scope:{sourceOrigin:'https://s3r.ch',destinationOrigin:'https://s3r.ch',application:'s3r.ch',tenant:'fixture',audience:'fixture'},
  keyringState:async(id:any)=>{reads++;assert.deepEqual(id,identity);return state;},protect:async()=>{protects++;return {key,protection:{version:1 as const,rpId:'s3r.ch' as const,credentialId:'fixture',prfSalt:'fixture'}};}};
 const envelope={version:1,principal:identity.principal,signingPub:identity.pub,epub:identity.epub,rotationSeq:0,ciphertext:Buffer.from(legacy.envelopeHex,'hex').toString('base64url')};
 return {input,factory,abort,envelope,file:()=>new TextEncoder().encode(JSON.stringify(envelope)),pass:()=>new TextEncoder().encode(legacy.passphraseUtf8),protects:()=>protects,reads:()=>reads,deactivate:()=>active=false,refuse:()=>refuse=true};
}
test('legacy weak passphrase restores only existing complete material and exact retry avoids another passkey',async()=>{
 const f=await setup(),pass=f.pass();const result=await restoreEncryptedRecovery(f.file(),pass,f.input);assert.equal(result.outcome,'stored');
 assert.equal(f.protects(),1);assert.deepEqual(pass,f.pass());assert.equal((await restoredKeyringRecords(f.factory)).length,1);
 const retry=await restoreEncryptedRecovery(f.file(),pass,f.input);assert.equal(retry.outcome,'existing');assert.equal(f.protects(),1);assert.equal(retry.record.sealed,result.record.sealed);
});
test('wrong passphrase, tamper, malformed, stale owner and account cancellation never prompt protection',async()=>{
 for(const mode of ['wrong','tamper','shape','size','owner','cancel','account']){
  const f=await setup();let bytes=f.file(),pass=f.pass();
  if(mode==='wrong')pass=new TextEncoder().encode('incorrect');
  if(mode==='tamper'){const cipher=Buffer.from(f.envelope.ciphertext,'base64url');cipher[cipher.length-1]^=1;f.envelope.ciphertext=cipher.toString('base64url');bytes=f.file();}
  if(mode==='shape')bytes=new TextEncoder().encode('{"version":1}');
  if(mode==='size')bytes=new Uint8Array(710001);
  if(mode==='owner')f.refuse();if(mode==='cancel')f.abort.abort();if(mode==='account')f.deactivate();
  await assert.rejects(restoreEncryptedRecovery(bytes,pass,f.input));assert.equal(f.protects(),0);assert.deepEqual(await restoredKeyringRecords(f.factory),[]);
 }
});
test('cancellation during decrypted-history validation refuses delivery and leaves storage untouched',async()=>{
 const f=await setup(),input={...f.input,keyringState:async(id:any)=>{const state=await f.input.keyringState(id);return ()=>{f.abort.abort();return state();};}};
 await assert.rejects(restoreEncryptedRecovery(f.file(),f.pass(),input));assert.equal(f.protects(),0);assert.deepEqual(await restoredKeyringRecords(f.factory),[]);
});

test('encrypted replacement requires the confirmed next rotation and preserves prior storage on a wrong passphrase',async()=>{
 const f=await setup(),vectors=fixture('browser-keyring'),records=fixture('records'),v=vectors.accept[1];
 const identity={principal:v.fields.principal,pub:v.fields.pub,epub:v.fields.epub,rotationSeq:v.fields.rotationSeq};
 const rotations=v.rotationNames.map((name:string)=>records.accept.find((r:any)=>r.name===name).input);
 const state=():any=>({rotations,context:{...records.context,links:new Map(records.context.links),revocations:[],pinnedIss:new Set(records.context.pinnedIss),genesisEpubBindings:v.genesisBindings,history:(p:any,at:number,until:number)=>records.context.authenticatedAccounts.includes(p)?{ok:true,value:historyState(p,[],at,until)}:{ok:false,reason:'missing-history'}}});
 const input={...f.input,keyringState:async()=>state},handle=importKeyring(new Uint8Array(Buffer.from(v.encodedHex,'hex')),identity,state);
 const phrase=new TextEncoder().encode('Glacier!marigold-97-violet-Copper!648-orbit');
 let file:Uint8Array;
 try{const envelope=await sealRecoveryKeyring(handle,phrase,state);const {bytes,...meta}=envelope;
  file=new TextEncoder().encode(JSON.stringify({version:1,...meta,ciphertext:Buffer.from(bytes).toString('base64url')}));
 }finally{closeKeyring(handle);}
 const result=await restoreEncryptedRecovery(file,phrase,input),rotation=rotations.at(-1);
 const previous={...result.record,identity:{...identity,pub:rotation.prevKey,epub:identity.principal,rotationSeq:identity.rotationSeq-1},seaPub:rotation.prevKey};
 const db=await openMeshDb(f.factory);await new Promise<void>((resolve,reject)=>{const tx=db.transaction(MESH_STORE_NAME,'readwrite');tx.objectStore(MESH_STORE_NAME).put(previous);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(Error());});db.close();
 await assert.rejects(replaceRotatedEncryptedRecovery(file,new TextEncoder().encode('wrong'),previous,input));
 assert.deepEqual(await restoredKeyringRecords(f.factory),[previous]);
 assert.equal((await replaceRotatedEncryptedRecovery(file,phrase,previous,input)).outcome,'stored');
 assert.deepEqual((await restoredKeyringRecords(f.factory))[0].identity,identity);
 phrase.fill(0);file.fill(0);
});
