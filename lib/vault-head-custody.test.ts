import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePrincipalId,signWithKeyring,historyState,type ResolutionContext} from 'sociacl-ids';
import {vaultSyncHeadSigningBytes,type VaultSyncHead} from 'sociacl-ids/vault-sync';
import {createVaultHeadCustody} from './vault-head-custody';
import fixture from './identity/vectors/first-contact-client.json';
const parsed=parsePrincipalId(fixture.request.sender);if(!parsed.ok)throw Error(parsed.reason);
const owner=parsed.value,vaultId='ab'.repeat(32),secret=new Uint8Array(32);secret[31]=1;
const context:ResolutionContext={now:20,jwks:{keys:[]},links:new Map(),pinnedIss:new Set(),policy:{allowedDomains:[],allowedUris:[],allowedChainIds:[],clockSkewSeconds:0},history:(p,at,until)=>({ok:true,value:historyState(p,[],at,until)})};
const current=()=>({rotations:[],context});
function signed(){const head:VaultSyncHead={v:1,owner,vaultId,revision:1,previousDigest:'00'.repeat(32),keybagDigest:'11'.repeat(32),indexDigest:'22'.repeat(32),minimumProfile:1,issuedAt:10,sig:'A'.repeat(86)};const result=signWithKeyring(secret,vaultSyncHeadSigningBytes(head),owner);if(!result.ok)throw Error(result.reason);return {...head,sig:result.value};}
const generate=()=>crypto.subtle.generateKey({name:'AES-KW',length:256},false,['wrapKey','unwrapKey']);
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
test('private head custody encrypts owner metadata with fresh keys and refuses substitution',async()=>{
 const key=await generate(),custody=createVaultHeadCustody({owner,vaultId,key,current}),head=signed();
 const bytes=await custody.seal(head),again=await custody.seal(head);
 assert.notDeepEqual(bytes,again);assert.deepEqual(await custody.open(bytes),head);
 assert.ok(!new TextDecoder().decode(bytes).includes(owner));
 const envelope=JSON.parse(new TextDecoder().decode(bytes));
 for(const changed of [{...envelope,unprotected:{alg:'A256KW'}},{...envelope,recipients:[...envelope.recipients,...envelope.recipients]},
  {...envelope,ciphertext:(envelope.ciphertext[0]==='A'?'B':'A')+envelope.ciphertext.slice(1)},
  {...envelope,protected:Buffer.from(JSON.stringify({alg:'A256KW',enc:'A256GCM',typ:'other',kid:vaultId})).toString('base64url')}])await assert.rejects(custody.open(encode(changed)));
 await assert.rejects(createVaultHeadCustody({owner,vaultId,key:await generate(),current}).open(bytes));
 await assert.rejects(createVaultHeadCustody({owner,vaultId:'cd'.repeat(32),key,current}).open(bytes));
 await assert.rejects(custody.seal({...head,sig:'A'.repeat(86)}));
 await assert.rejects(custody.open(new Uint8Array(65537)));
 custody.lock();await assert.rejects(custody.open(bytes));await assert.rejects(custody.seal(head));
});
test('locking prevents an in-flight decrypt from returning; exportable keys are refused',async()=>{
 const key=await generate(),custody=createVaultHeadCustody({owner,vaultId,key,current}),bytes=await custody.seal(signed());
 const pending=custody.open(bytes);custody.lock();await assert.rejects(pending);
 const exportable=await crypto.subtle.generateKey({name:'AES-KW',length:256},true,['wrapKey','unwrapKey']);
 assert.throws(()=>createVaultHeadCustody({owner,vaultId,key:exportable,current}));
});
