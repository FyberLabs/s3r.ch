// Native keyring, wallet and storage contracts execute only in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {p256} from '@noble/curves/nist.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {createHash} from 'node:crypto';
import {hashMessage,hexToBytes} from 'viem';
const sha256=(value:Uint8Array)=>new Uint8Array(createHash('sha256').update(value).digest());
import {historyState,lengthPrefixed} from 'sociacl-ids';
import {admitKeyring,exportKeyring,importKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {prepareRecoveryRotation} from './recovery-rotation-client';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL('../.pairing-test-vectors/'+name+'.json',import.meta.url),'utf8'));
const b64=(v:Uint8Array)=>Buffer.from(v).toString('base64url'),hex=(v:Uint8Array)=>Buffer.from(v).toString('hex');
function setup(){
 const records=fixture('records'),fields=structuredClone(fixture('browser-keyring').accept[1].fields),scalar=new Uint8Array(32),encryption=new Uint8Array(32);scalar[31]=1;encryption[31]=9;
 Object.assign(fields,{pub:fields.principal,priv:b64(scalar),epub:fields.genesisEpub,epriv:b64(encryption),rotationSeq:0,contentEpoch:0,retired:[],priorLanes:[],priorContactSecrets:[]});
 const key=new Uint8Array(32);key[31]=7;const point=p256.getPublicKey(key,false),jwks=structuredClone(records.context.jwks);
 jwks.keys.push({kty:'EC',crv:'P-256',kid:'rotation-fixture',x:b64(point.slice(1,33)),y:b64(point.slice(33)),alg:'ES256',use:'sig',key_ops:['verify'],notBefore:0,notAfter:records.context.now+10000});
 let rotation:any,pending:any=null,generation=0,active=true,stored=0,publicationWrites=0,backupWrites=0,revision=0;
 const identity={principal:fields.principal,pub:fields.pub,epub:fields.epub,rotationSeq:0},abort=new AbortController();
 const context:any={...records.context,jwks,links:new Map(records.context.links),pinnedIss:new Set(records.context.pinnedIss),revocations:[],
  genesisEpubBindings:records.accept.find((r:any)=>r.name==='binding-valid-no-rotation').genesisEpubBindings,
  history:(p:any,at:number,until:number)=>({ok:true,value:historyState(p,rotation?[rotation]:[],at,until)})};
 const state=():any=>({rotations:rotation?[rotation]:[],context});
 const handle=admitKeyring(fields,identity,state),material=exportKeyring(handle,state);closeKeyring(handle);
 const head=()=>rotation?{sequence:rotation.seq,currentKey:rotation.nextKey,currentEpub:rotation.nextEpub}:{sequence:0,currentKey:identity.pub,currentEpub:identity.epub};
 const walletRecord=records.context.links.find(([,v]:any)=>v.kind==='wallet')[1];
 const wallet={current:()=>({address:walletRecord.address,chainId:'1',walletRevision:revision,sessionRevision:0}),signMessage:async(message:string)=>{
  const secret=new Uint8Array(32);secret[31]=4;const sig=secp256k1.sign(hexToBytes(hashMessage(message)),secret,{prehash:false,format:'recovered'});
  return '0x'+hex(new Uint8Array([...sig.slice(1),sig[0]+27]));
 }};
 const input={origin:'https://s3r.ch',current:()=>active,signal:abort.signal,keyringState:async()=>state,
  store:async(bytes:Uint8Array,id:any)=>{const opened=importKeyring(bytes,id,state);try{assert.equal(opened.rotationSeq,1);stored++;}finally{closeKeyring(opened);}},
  request:async(action:string,value:any):Promise<unknown>=>{
   assert.equal(JSON.stringify(value).includes(fields.priv),false);
   if(action==='recovery-read')return {generation,head:head(),row:pending};
   if(action==='recovery-put'){assert.match(value.signature,/^[a-f0-9]{128}$/);pending=structuredClone(value.row);backupWrites++;return {generation:++generation};}
   if(action==='rotation-witness'){
    const claims={typ:'sociacl-rotate-attest-v4',principal:value.principal,nextKey:value.nextKey,nextEpub:value.nextEpub,seq:value.seq,iat:value.issuedAt,exp:value.issuedAt+600,auth:'wallet',linkId:value.authorizer.link,retainedLinks:value.retainedLinks,
     siweHash:hex(sha256(lengthPrefixed(['sociacl-siwe-proof-v1',value.authorizer.siwe.message,value.authorizer.siwe.signature])))};
    const token=b64(new TextEncoder().encode(JSON.stringify({alg:'ES256',kid:'rotation-fixture',typ:'JWT'})))+'.'+b64(new TextEncoder().encode(JSON.stringify(claims)));
    return {attest:token+'.'+b64(p256.sign(sha256(new TextEncoder().encode(token)),key,{prehash:false,format:'compact'}))};
   }
   if(action==='rotation-state')return {recordHash:'ab'.repeat(32),present:!!rotation,head:head()};
   if(action==='rotation-publish'){rotation=structuredClone(value);publicationWrites++;return {recordHash:'ab'.repeat(32)};}
   throw Error('unexpected action');
  }};
 return {input,wallet,material,identity,context,abort,pass:()=>new TextEncoder().encode(fixture('recovery-copy').passphraseUtf8),get stored(){return stored;},get publicationWrites(){return publicationWrites;},get backupWrites(){return backupWrites;},changeWallet(){revision++;},stop(){active=false;},changeBackup(){pending=null;}};
}
async function prepare(f:ReturnType<typeof setup>){return prepareRecoveryRotation(f.material,f.identity,['lost-device','kept-device'],'lost-device',f.pass(),'account',f.input);}
test('explicit rotation preserves separate backup, wallet, publication and protection outcomes',async()=>{
 const f=setup(),flow=await prepare(f);try{
  assert.equal(flow.phase,'prepared');assert.equal(f.backupWrites,0);assert.equal(f.publicationWrites,0);
  const file=JSON.parse(new TextDecoder().decode(flow.file()));assert.equal(file.rotationSeq,1);assert.equal(file.principal,f.identity.principal);
  await assert.rejects(flow.publish());await assert.rejects(flow.authorize(f.wallet));await assert.rejects(flow.protect());
  assert.equal(await flow.save(),'stored');assert.equal(await flow.save(),'already-stored');assert.equal(f.backupWrites,1);
  await flow.authorize(f.wallet);assert.equal(flow.phase,'authorized');assert.equal(f.publicationWrites,0);
  await flow.publish();await flow.publish();assert.equal(f.publicationWrites,1);assert.equal(flow.phase,'published');
  await flow.protect();assert.equal(f.stored,1);assert.equal(flow.phase,'stored');assert.throws(()=>flow.file());
 }finally{flow.close();}
});
test('lost responses reconcile without resending writes',async()=>{
 const f=setup(),request=f.input.request;f.input.request=async(action,value)=>{const result=await request(action,value);if(action==='recovery-put'||action==='rotation-publish')throw Error('lost response');return result;};
 const flow=await prepare(f);try{await flow.save();await flow.authorize(f.wallet);await flow.publish();await flow.publish();assert.equal(f.backupWrites,1);assert.equal(f.publicationWrites,1);}finally{flow.close();}
});
test('wallet changes, conflicting backup, stale authority and cancellation never publish',async()=>{
 for(const mode of ['wallet','backup','owner','cancel','wrong-wallet','bad-proof','witness']){
  const f=setup(),flow=await prepare(f);try{
   await flow.save();
   if(mode==='wrong-wallet')f.wallet.current=()=>({address:'0x0000000000000000000000000000000000000001',chainId:'1',walletRevision:0,sessionRevision:0});
   if(mode==='bad-proof')f.wallet.signMessage=async()=> '0x'+'00'.repeat(65);
   if(mode==='witness'){const request=f.input.request;f.input.request=async(a,v)=>a==='rotation-witness'?{attest:'invalid'}:request(a,v);}
   if(['wrong-wallet','bad-proof','witness'].includes(mode)){await assert.rejects(flow.authorize(f.wallet));}
   else{await flow.authorize(f.wallet);if(mode==='wallet')f.changeWallet();if(mode==='backup')f.changeBackup();if(mode==='owner')f.stop();if(mode==='cancel')f.abort.abort();await assert.rejects(flow.publish());}
   assert.equal(f.publicationWrites,0);assert.equal(f.stored,0);
  }finally{flow.close();}
 }
});
test('weak passphrase and cancelled preparation return no pending controller',async()=>{
 const f=setup();await assert.rejects(prepareRecoveryRotation(f.material,f.identity,['lost'],'lost',new TextEncoder().encode('password'),'account',f.input));
 f.abort.abort();await assert.rejects(prepare(f));
});
