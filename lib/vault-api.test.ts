import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePrincipalId, signWithKeyring } from 'sociacl-ids';
import fixture from './identity/vectors/first-contact-client.json';
import { createVaultApiService } from './vault-api-service';
import { createVaultApiTransport } from './vault-api-client';
import { vaultOperationBytes, type VaultOperation } from './vault-api-contract';
const parsed=parsePrincipalId(fixture.request.sender);if(!parsed.ok)throw Error(parsed.reason);
const owner=parsed.value,vaultId='ab'.repeat(32),origin='https://vault.example',key=new Uint8Array(32);key[31]=1;
const sign=async(bytes:Uint8Array)=>{const s=signWithKeyring(key,bytes,owner);if(!s.ok)throw Error(s.reason);return s.value;};
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function setup(){
  let session:{owner:string;key:string}|null={owner,key:owner},calls=0,now=20,after=()=>{};
  let head:{bytes:Uint8Array;revision:string}|null=null;
  const objects=new Map<string,Uint8Array>();
  const service=createVaultApiService({origin,bindings:[{owner,vaultId}],clock:()=>now,resolve:async()=>session,transport:()=>({
    read:async()=>{calls++;after();return head;},
    write:async(_id,bytes,expected)=>{calls++;if((head?.revision??null)!==expected)throw Error('Conflict');head={bytes,revision:hash(bytes)};after();return head.revision;},
    putObject:async(id,bytes)=>{calls++;objects.set(id,bytes);after();},getObject:async id=>{calls++;after();return objects.get(id)??null;}
  })});
  const fetcher=(async(url,init)=>{assert.equal(init?.credentials,'same-origin');assert.equal(init?.redirect,'error');
    const headers=new Headers(init?.headers);headers.set('Origin',origin);return service(new Request(url,{...init,headers}));}) as typeof fetch;
  const client=createVaultApiTransport({origin,owner,vaultId,sign,fetch:fetcher,clock:()=>now});
  return {service,client,calls:()=>calls,setSession:(s:typeof session)=>{session=s;},setNow:(n:number)=>{now=n;},after:(f:()=>void)=>{after=f;}};
}
async function request(patch:Partial<VaultOperation>={},bodyPatch:Record<string,unknown>={},requestOrigin=origin){
  const bytes=new TextEncoder().encode('ciphertext');
  const op:VaultOperation={v:1,origin,owner,vaultId,action:'write',id:vaultId,digest:hash(bytes),expected:null,issuedAt:20,expiresAt:80,...patch};
  return new Request(origin+'/api/vault',{method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify({op,sig:await sign(vaultOperationBytes(op)),bytes:Buffer.from(bytes).toString('base64'),...bodyPatch})});
}
test('authenticated vault transport binds owner signatures and preserves storage CAS',async()=>{
  const s=setup(),bytes=new TextEncoder().encode('ciphertext');
  assert.equal(await s.client.read(vaultId),null);
  await s.client.putObject(hash(bytes),bytes);assert.deepEqual(await s.client.getObject(hash(bytes)),bytes);
  const tag=await s.client.write(vaultId,bytes,null);assert.deepEqual(await s.client.read(vaultId),{bytes,revision:tag});
  await assert.rejects(s.client.write(vaultId,new Uint8Array([2]),null));
  assert.equal((await s.client.read(vaultId))?.revision,tag);
});
test('session alone, another owner, changed bytes, cross-origin and expired proofs cannot reach storage',async()=>{
  const s=setup();
  for(const req of [await request({}, {sig:'A'.repeat(86)}),await request({}, {bytes:Buffer.from('other').toString('base64')}),await request({}, {}, 'https://other.example'),await request({expiresAt:21})]){
    s.setNow(21);assert.ok([400,403].includes((await s.service(req)).status));
  }
  s.setNow(20);s.setSession({owner:'other',key:owner});assert.equal((await s.service(await request())).status,403);
  s.setSession(null);assert.equal((await s.service(await request())).status,403);assert.equal(s.calls(),0);
});
test('unknown vaults and revoked sessions fail closed; completed writes may have an ambiguous response',async()=>{
  const s=setup(),other='cd'.repeat(32);
  assert.equal((await s.service(await request({vaultId:other,id:other}))).status,403);assert.equal(s.calls(),0);
  s.after(()=>s.setSession(null));assert.equal((await s.service(await request())).status,403);assert.equal(s.calls(),1);
});
