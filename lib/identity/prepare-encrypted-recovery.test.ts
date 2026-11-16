// Native crypto contract: CI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {historyState} from 'sociacl-ids';
import {openRecoveryKeyring} from 'sociacl-ids/recovery';
import {exportKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {prepareEncryptedRecovery} from './prepare-encrypted-recovery';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL('../.pairing-test-vectors/'+name+'.json',import.meta.url),'utf8'));
function setup(){
 const v=fixture('browser-keyring').accept[1],records=fixture('records'),{principal,pub,epub,rotationSeq}=v.fields;
 const identity={principal,pub,epub,rotationSeq},abort=new AbortController();let active=true;
 const state=():any=>({rotations:v.rotationNames.map((name:string)=>records.accept.find((r:any)=>r.name===name).input),context:{jwks:records.context.jwks,links:new Map(records.context.links),revocations:[],now:records.context.now,policy:records.context.policy,pinnedIss:new Set(records.context.pinnedIss),genesisEpubBindings:v.genesisBindings,history:(p:any,at:number,until:number)=>records.context.authenticatedAccounts.includes(p)?{ok:true,value:historyState(p,[],at,until)}:{ok:false,reason:'missing-history'}}});
 return {identity,abort,state,material:()=>new Uint8Array(Buffer.from(v.encodedHex,'hex')),pass:()=>new TextEncoder().encode(fixture('recovery-copy').passphraseUtf8),
 input:{signal:abort.signal,current:()=>active,keyringState:async()=>state},deactivate:()=>active=false};
}
test('downloaded ciphertext round-trips complete historical material and snapshots caller secrets',async()=>{
 const f=setup(),material=f.material(),pass=f.pass(),pending=prepareEncryptedRecovery(material,f.identity,pass,'public-handle',f.input);
 material.fill(0);pass.fill(0);
 const bytes=await pending,value=JSON.parse(new TextDecoder().decode(bytes));
 assert.deepEqual(Object.keys(value).sort(),['ciphertext','epub','principal','rotationSeq','signingPub','version']);
 const handle=await openRecoveryKeyring(f.pass(),{principal:value.principal,signingPub:value.signingPub,epub:value.epub,rotationSeq:value.rotationSeq,bytes:new Uint8Array(Buffer.from(value.ciphertext,'base64url'))},f.identity,f.state);
 try{assert.deepEqual(exportKeyring(handle,f.state),f.material());}finally{closeKeyring(handle);}
});
test('weak or known-handle passphrases, stale ownership, malformed material and cancellation refuse downloads',async()=>{
 for(const mode of ['weak','known','empty','size','empty-phrase','handle','bad-material','owner','cancel','account','late-cancel']){
  const f=setup();let material=f.material(),pass=f.pass(),account='';
  if(mode==='weak')pass=new TextEncoder().encode('password');
  if(mode==='known'){account='q7vN2mR9pL4xT8wK3c';pass=new TextEncoder().encode(account);}
  if(mode==='empty')material=new Uint8Array();if(mode==='size')material=new Uint8Array(524289);
  if(mode==='empty-phrase')pass=new Uint8Array();if(mode==='handle')account='a'.repeat(256);
  if(mode==='bad-material')material[0]^=1;
  if(mode==='owner')f.input.keyringState=async()=>{throw Error();};
  if(mode==='cancel')f.abort.abort();if(mode==='account')f.deactivate();
  const pending=prepareEncryptedRecovery(material,f.identity,pass,account,f.input);
  if(mode==='late-cancel')f.abort.abort();
  await assert.rejects(pending,mode==='weak'||mode==='known'?/recovery-weak-passphrase/:/Recovery copy unavailable/);
 }
});
