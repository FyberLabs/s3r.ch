import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { parsePrincipalId, signWithKeyring, historyState, type ResolutionContext } from 'sociacl-ids';
import { openVaultSyncHeadStore, vaultSyncHeadFloor, vaultSyncHeadSigningBytes, type VaultSyncHead } from 'sociacl-ids/vault-sync';
import fixture from './identity/vectors/first-contact-client.json';
import { createSealedVaultStorageClient } from './vault-head-custody';
import { createVaultApiTransport } from './vault-api-client';
import { createVaultApiService } from './vault-api-service';
import { createVaultScopedStore } from './vault-scoped-store-server';
const parsed=parsePrincipalId(fixture.request.sender);if(!parsed.ok)throw Error(parsed.reason);
const owner=parsed.value,vaultId='ab'.repeat(32),origin='https://vault.example',key=new Uint8Array(32);key[31]=1;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const sign=(bytes:Uint8Array)=>{const result=signWithKeyring(key,bytes,owner);if(!result.ok)throw Error(result.reason);return result.value;};
const keybag=encode('encrypted-keybag-fixture'),index=encode('encrypted-index-fixture');
const context:ResolutionContext={now:20,jwks:{keys:[]},links:new Map(),pinnedIss:new Set(),
 policy:{allowedDomains:[],allowedUris:[],allowedChainIds:[],clockSkewSeconds:0},
 history:(p,at,until)=>({ok:true,value:historyState(p,[],at,until)})};
const current=()=>({rotations:[],context});
function signed(patch:Partial<VaultSyncHead>={}):VaultSyncHead{
 const value:VaultSyncHead={v:1,owner,vaultId,revision:1,previousDigest:'00'.repeat(32),keybagDigest:hash(keybag),indexDigest:hash(index),minimumProfile:1,issuedAt:10,sig:'A'.repeat(86),...patch};
 return {...value,sig:sign(vaultSyncHeadSigningBytes(value))};
}
test('signed vault publication crosses authenticated API and scoped storage before retaining its head',async()=>{
 const root=signed(),indexedDB=new IDBFactory(),options={name:'authenticated-publication',owner,vaultId,anchor:vaultSyncHeadFloor(root),now:()=>20,indexedDB};
 const floor=await openVaultSyncHeadStore({...options,create:true});
 const rows=new Map<string,{bytes:Uint8Array;revision:string}>();let writes=0,headWrites=0,authenticated=true,lost=true;
 const storageFetch=(async(url,init)=>{
  const path=new URL(String(url)).pathname;assert.ok(path.startsWith('/api/v1/storage/records/vault/'));
  const old=rows.get(path),headers=new Headers(init?.headers);
  if(init?.method==='PUT'){
   if(old?headers.get('If-Match')!=='"'+old.revision+'"':headers.get('If-None-Match')!=='*')return new Response(null,{status:412});
   const revision=(++writes).toString(16).padStart(64,'0');if(path.endsWith('/'+vaultId))headWrites++;
   rows.set(path,{bytes:new Uint8Array(init.body as Uint8Array),revision});
   return new Response(null,{status:old?204:201,headers:{ETag:'"'+revision+'"'}});
  }
  return old?new Response(new Uint8Array(old.bytes),{headers:{ETag:'"'+old.revision+'"','Content-Length':String(old.bytes.length)}}):new Response(null,{status:404});
 }) as typeof fetch;
 const store=createVaultScopedStore({origin:'https://storage.example',tenant:'11111111-1111-4111-8111-111111111111',apiKey:'fixture-key'},vaultId,storageFetch);
 const service=createVaultApiService({origin,bindings:[{owner,vaultId}],transport:()=>store,resolve:async()=>authenticated?{owner,key:owner}:null,clock:()=>20});
 const fetcher=(async(url,init)=>{
  const headers=new Headers(init?.headers);headers.set('Origin',origin);
  const response=await service(new Request(url,{...init,headers}));
  const action=JSON.parse(init!.body as string).op.action;
  if(action==='write'&&response.ok&&lost){lost=false;await response.body?.cancel();throw Error('Simulated lost committed response');}
  return response;
 }) as typeof fetch;
 const transport=createVaultApiTransport({origin,owner,vaultId,sign:async bytes=>sign(bytes),clock:()=>20,fetch:fetcher});
 const localKey=await crypto.subtle.generateKey({name:'AES-KW',length:256},false,['wrapKey','unwrapKey']);
 const client=createSealedVaultStorageClient({owner,vaultId,floor,transport,current,key:localKey});
 const rootBytes=await client.sealHead(root);
 try{
  const first=await client.publish({encryptedHead:rootBytes,keybag,index,previous:null,expectedStorageRevision:null});
  assert.equal(headWrites,1);
  await client.publish({encryptedHead:rootBytes,keybag,index,previous:null,expectedStorageRevision:null});assert.equal(headWrites,1);
  const path='/api/v1/storage/records/vault/'+vaultId,old=structuredClone(rows.get(path)!);
  const next=signed({revision:2,previousDigest:vaultSyncHeadFloor(root).digest,issuedAt:11});
  const nextBytes=await client.sealHead(next);
  await client.publish({encryptedHead:nextBytes,keybag,index,previous:root,expectedStorageRevision:first.storageRevision});
  assert.deepEqual(await floor.read(),vaultSyncHeadFloor(next));
  assert.deepEqual((await client.readCurrent()).head,next);
  rows.set(path,old);await assert.rejects(client.readCurrent());assert.deepEqual(await floor.read(),vaultSyncHeadFloor(next));
  authenticated=false;const before=writes;
  await assert.rejects(client.publish({encryptedHead:nextBytes,keybag,index,previous:root,expectedStorageRevision:first.storageRevision}));assert.equal(writes,before);
  floor.close();const reopened=await openVaultSyncHeadStore(options);
  assert.deepEqual(await reopened.read(),vaultSyncHeadFloor(next));reopened.close();
 }finally{client.lock();floor.close();}
});
