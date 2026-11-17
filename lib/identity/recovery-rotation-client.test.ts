// Native keyring, wallet and storage contracts execute only in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {p256} from '@noble/curves/nist.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {createHash} from 'node:crypto';
import {hashMessage,hexToBytes} from 'viem';
const sha256=(value:Uint8Array)=>new Uint8Array(createHash('sha256').update(value).digest());
import {historyState,lengthPrefixed,signingBytes,signWithKeyring,linkId} from 'sociacl-ids';
import {admitKeyring,exportKeyring,importKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {openRecoveryKeyring,signRecoveryCommit} from 'sociacl-ids/recovery';
import {commitRecoveryCopy} from './recovery-store-commit';
import {recoveryFileRow,recoveryRowEnvelope} from './recovery-file';
import {prepareRecoveryRotation} from './recovery-rotation-client';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL('../.pairing-test-vectors/'+name+'.json',import.meta.url),'utf8'));
const b64=(v:Uint8Array)=>Buffer.from(v).toString('base64url'),hex=(v:Uint8Array)=>Buffer.from(v).toString('hex');
function walletSignature(message:string){
 const secret=new Uint8Array(32);secret[31]=4;const sig=secp256k1.sign(hexToBytes(hashMessage(message)),secret,{prehash:false,format:'recovered'});
 return '0x'+hex(new Uint8Array([...sig.slice(1),sig[0]+27]));
}
function setup(legacy=false){
 const records=fixture('records'),fields=structuredClone(fixture('browser-keyring').accept[1].fields),scalar=new Uint8Array(32),encryption=new Uint8Array(32);scalar[31]=1;encryption[31]=9;
 Object.assign(fields,{pub:fields.principal,priv:b64(scalar),epub:fields.genesisEpub,epriv:b64(encryption),rotationSeq:0,contentEpoch:0,retired:[],priorLanes:[],priorContactSecrets:[]});
 const account=fixture('account-keyring');if(legacy){const g=account.genesis;Object.assign(fields,{principal:g.principal,pub:g.signingPub,priv:g.signingPriv,genesisEpub:g.epub,epub:g.epub,epriv:g.epriv,laneId:g.laneId,contactLaneSecret:g.contactLaneSecret});}
 const key=new Uint8Array(32);key[31]=7;const point=p256.getPublicKey(key,false),jwks=structuredClone(records.context.jwks);
 jwks.keys.push({kty:'EC',crv:'P-256',kid:'rotation-fixture',x:b64(point.slice(1,33)),y:b64(point.slice(33)),alg:'ES256',use:'sig',key_ops:['verify'],notBefore:0,notAfter:records.context.now+10000});
 let rotation:any,pending:any=null,currentRow:any=null,storedBytes:Uint8Array|undefined,generation=0,active=true,stored=0,publicationWrites=0,backupWrites=0,revision=0;
 const identity={principal:fields.principal,pub:fields.pub,epub:fields.epub,rotationSeq:0},abort=new AbortController();
 const context:any={...records.context,jwks,links:new Map(records.context.links),pinnedIss:new Set(records.context.pinnedIss),revocations:[],
  genesisEpubBindings:legacy?[account.genesisBinding]:records.accept.find((r:any)=>r.name==='binding-valid-no-rotation').genesisEpubBindings,
  history:(p:any,at:number,until:number)=>({ok:true,value:historyState(p,rotation?[rotation]:[],at,until)})};
 if(legacy){
  const record:any={v:1,kind:'wallet',principal:fields.principal,address:account.wallet,issuedAt:context.now-30,nonce:'legacyRecovery123',keySig:'',siwe:{message:'',signature:''},attest:''};
  const bytes=signingBytes(record);assert.ok(bytes.ok);const id=hex(sha256(bytes.value));
  const signature=signWithKeyring(new Uint8Array(Buffer.from(account.genesis.signingScalarHex,'hex')),bytes.value,fields.principal);assert.ok(signature.ok);record.keySig=signature.value;
  const message=`s3r.ch wants you to sign in with your Ethereum account:\n${account.wallet}\n\nSociACL link: ${id}\n\nURI: https://s3r.ch/identity/link\nVersion: 1\nChain ID: 1\nNonce: legacyRecovery123\nIssued At: ${new Date(record.issuedAt*1000).toISOString().replace('.000Z','Z')}`;
  record.siwe={message,signature:walletSignature(message)};
  const claims={typ:'sociacl-wallet-attest-v1',principal:fields.principal,linkId:id,iat:record.issuedAt,exp:record.issuedAt+600};
  const token=b64(new TextEncoder().encode(JSON.stringify({alg:'ES256',kid:'rotation-fixture',typ:'JWT'})))+'.'+b64(new TextEncoder().encode(JSON.stringify(claims)));
  record.attest=token+'.'+b64(p256.sign(sha256(new TextEncoder().encode(token)),key,{prehash:false,format:'compact'}));
  const checked=linkId(record);assert.ok(checked.ok);assert.equal(checked.value,id);context.links=new Map([[id,record]]);
 }
 const state=():any=>({rotations:rotation?[rotation]:[],context});
 const handle=admitKeyring(fields,identity,state),material=exportKeyring(handle,state);closeKeyring(handle);
 const head=()=>rotation?{sequence:rotation.seq,currentKey:rotation.nextKey,currentEpub:rotation.nextEpub}:{sequence:0,currentKey:identity.pub,currentEpub:identity.epub};
 const walletRecord=[...context.links.values()].find((v:any)=>v.kind==='wallet') as any;
 const wallet={current:()=>({address:walletRecord.address,chainId:'1',walletRevision:revision,sessionRevision:0}),signMessage:async(message:string)=>{
  return walletSignature(message);
 }};
 const input={origin:'https://s3r.ch',current:()=>active,signal:abort.signal,keyringState:async()=>state,
  store:async(bytes:Uint8Array,id:any,current:()=>boolean)=>{assert.equal(current(),true);const opened=importKeyring(bytes,id,state);try{assert.equal(opened.rotationSeq,1);storedBytes=new Uint8Array(bytes);stored++;}finally{closeKeyring(opened);}},
  request:async(action:string,value:any):Promise<unknown>=>{
   assert.equal(JSON.stringify(value).includes(fields.priv),false);
   if(action==='recovery-read')return {generation,head:head(),row:value.slot==='pending'?pending:currentRow};
   if(action==='recovery-put'){assert.match(value.signature,/^[a-f0-9]{128}$/);pending=structuredClone(value.row);backupWrites++;return {generation:++generation};}
   if(action==='recovery-commit'){assert.match(value.signature,/^[a-f0-9]{128}$/);currentRow=pending;pending=null;return {generation:++generation};}
   if(action==='rotation-witness'){
    const proof=lengthPrefixed(['sociacl-siwe-proof-v1',value.authorizer.siwe.message,value.authorizer.siwe.signature]);assert.ok(proof.ok);
    const claims={typ:'sociacl-rotate-attest-v4',principal:value.principal,nextKey:value.nextKey,nextEpub:value.nextEpub,seq:value.seq,iat:value.issuedAt,exp:value.issuedAt+600,auth:'wallet',linkId:value.authorizer.link,retainedLinks:value.retainedLinks,
     siweHash:hex(sha256(proof.value))};
    const token=b64(new TextEncoder().encode(JSON.stringify({alg:'ES256',kid:'rotation-fixture',typ:'JWT'})))+'.'+b64(new TextEncoder().encode(JSON.stringify(claims)));
    return {attest:token+'.'+b64(p256.sign(sha256(new TextEncoder().encode(token)),key,{prehash:false,format:'compact'}))};
   }
   if(action==='rotation-state')return {recordHash:'ab'.repeat(32),present:!!rotation,head:head()};
   if(action==='rotation-publish'){rotation=structuredClone(value);publicationWrites++;return {recordHash:'ab'.repeat(32)};}
   throw Error('unexpected action');
  }};
 return {input,wallet,material,identity,context,abort,state,get storedBytes(){return storedBytes;},seedCurrent(row:any){currentRow=row;},pass:()=>new TextEncoder().encode(fixture('recovery-copy').passphraseUtf8),get stored(){return stored;},get publicationWrites(){return publicationWrites;},get backupWrites(){return backupWrites;},changeWallet(){revision++;},stop(){active=false;},changeBackup(){pending=null;}};
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
 for(const mode of ['wallet','backup','owner','cancel','wrong-wallet','bad-proof','witness','history','revoked','ambiguous','during-sign']){
  const f=setup(),flow=await prepare(f);try{
   await flow.save();
   if(mode==='wrong-wallet')f.wallet.current=()=>({address:'0x0000000000000000000000000000000000000001',chainId:'1',walletRevision:0,sessionRevision:0});
   if(mode==='bad-proof')f.wallet.signMessage=async()=> '0x'+'00'.repeat(65);
   if(mode==='history')f.context.history=()=>({ok:false,reason:'missing-history'});
   if(mode==='revoked'||mode==='ambiguous'){
    const row=fixture('records').reject.find((r:any)=>r.name===(mode==='revoked'?'newest-wallet-revoked':'duplicate-wallet-tie'));
    for(const value of row.input){const id=linkId(value);assert.ok(id.ok);f.context.links.set(id.value,value);}f.context.revocations=row.revocations??[];
   }
   if(mode==='during-sign'){const sign=f.wallet.signMessage;f.wallet.signMessage=async message=>{const value=await sign(message);f.changeWallet();return value;};}
   if(mode==='witness'){const request=f.input.request;f.input.request=async(a,v)=>a==='rotation-witness'?{attest:'invalid'}:request(a,v);}
   if(['wrong-wallet','bad-proof','witness','history','revoked','ambiguous','during-sign'].includes(mode)){await assert.rejects(flow.authorize(f.wallet));}
   else{await flow.authorize(f.wallet);if(mode==='wallet')f.changeWallet();if(mode==='backup')f.changeBackup();if(mode==='owner')f.stop();if(mode==='cancel')f.abort.abort();await assert.rejects(flow.publish());}
   assert.equal(f.publicationWrites,0);assert.equal(f.stored,0);
  }finally{flow.close();}
 }
});
test('weak passphrase and cancelled preparation return no pending controller',async()=>{
 const f=setup();await assert.rejects(prepareRecoveryRotation(f.material,f.identity,['lost'],'lost',new TextEncoder().encode('password'),'account',f.input));
 f.abort.abort();await assert.rejects(prepare(f));
});

test('old weak-passphrase recovery rotates, protects and promotes the exact new-passphrase backup',async()=>{
 const f=setup(true),legacy=fixture('recovery-legacy-strength'),oldEnvelope={principal:f.identity.principal,signingPub:f.identity.pub,epub:f.identity.epub,rotationSeq:0,bytes:new Uint8Array(Buffer.from(legacy.envelopeHex,'hex'))};
 const old=await openRecoveryKeyring(new TextEncoder().encode(legacy.passphraseUtf8),oldEnvelope,f.identity,f.state);
 let material:Uint8Array|undefined,flow:Awaited<ReturnType<typeof prepareRecoveryRotation>>|undefined;
 try{
  material=exportKeyring(old,f.state);f.seedCurrent({principal:f.identity.principal,signingPub:f.identity.pub,epub:f.identity.epub,rotationSeq:0,bytesHex:hex(oldEnvelope.bytes)});
  flow=await prepareRecoveryRotation(material,f.identity,['lost'],'lost',f.pass(),'account',f.input);
  const row=recoveryFileRow(flow.file());await flow.save();await flow.authorize(f.wallet);await flow.publish();await flow.protect();
  const reopened=await openRecoveryKeyring(f.pass(),recoveryRowEnvelope(row),flow.identity,f.state);
  try{assert.deepEqual(exportKeyring(reopened,f.state),f.storedBytes);}finally{closeKeyring(reopened);}
  const active=importKeyring(f.storedBytes!,flow.identity,f.state);
  try{
   const result=await commitRecoveryCopy(row,{current:f.input.current,signal:f.abort.signal,read:slot=>f.input.request('recovery-read',{slot}),
    authorize:async()=>{const bytes=exportKeyring(active,f.state);bytes.fill(0);},
    sign:async view=>{assert.ok(view.pending);return signRecoveryCommit(active,{...view,current:view.current?recoveryRowEnvelope(view.current):null,pending:recoveryRowEnvelope(view.pending)},f.state);},
    write:operation=>f.input.request('recovery-commit',operation)});
   assert.equal(result,'committed');assert.equal((await f.input.request('recovery-read',{slot:'pending'}) as any).row,null);
  }finally{closeKeyring(active);}
 }finally{material?.fill(0);f.storedBytes?.fill(0);flow?.close();closeKeyring(old);}
});

test('local protection receives the attempt guard so cancellation prevents a late commit',async()=>{
 const f=setup(),flow=await prepare(f);try{
  await flow.save();await flow.authorize(f.wallet);await flow.publish();
  f.input.store=async(_bytes,_identity,current)=>{flow.close();assert.equal(current(),false);throw Error('cancelled');};
  await assert.rejects(flow.protect());assert.equal(flow.phase,'closed');assert.equal(f.stored,0);
 }finally{flow.close();}
});

test('concurrent steps are refused while the first backup read is pending',async()=>{
 const f=setup(),flow=await prepare(f),request=f.input.request;let release:()=>void=()=>{};
 f.input.request=async(action,value)=>{if(action==='recovery-read')await new Promise<void>(resolve=>{release=resolve;});return request(action,value);};
 try{const first=flow.save();await assert.rejects(flow.save(),/already running/);f.input.request=request;release();await first;assert.equal(f.backupWrites,1);}finally{flow.close();}
});
