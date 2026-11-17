import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVaultScopedStore} from './vault-scoped-store-server';
test('vault objects are isolated even when owners know the same ciphertext digest',async()=>{
  const rows=new Map<string,Uint8Array>(),tag='aa'.repeat(32);
  const fetcher=(async(url,init)=>{
    const name=String(url);assert.ok(name.includes('/records/vault/'));assert.ok(!name.includes('/objects/'));
    const old=rows.get(name);
    if(init?.method==='PUT'){
      assert.equal(new Headers(init.headers).get('If-None-Match'),'*');
      if(old)return new Response(null,{status:412});
      rows.set(name,new Uint8Array(init.body as Uint8Array));return new Response(null,{status:201,headers:{ETag:'"'+tag+'"'}});
    }
    return old?new Response(new Uint8Array(old),{headers:{ETag:'"'+tag+'"','Content-Length':String(old.length)}}):new Response(null,{status:404});
  }) as typeof fetch;
  const config={origin:'https://storage.example',tenant:'11111111-1111-4111-8111-111111111111',apiKey:'fixture-key'};
  const a=createVaultScopedStore(config,'ab'.repeat(32),fetcher),b=createVaultScopedStore(config,'cd'.repeat(32),fetcher);
  const bytes=new Uint8Array([1,2,3]),id=createHash('sha256').update(bytes).digest('hex');
  await a.putObject(id,bytes);await a.putObject(id,bytes);
  assert.deepEqual(await a.getObject(id),bytes);assert.equal(await b.getObject(id),null);
  await b.putObject(id,bytes);assert.equal(rows.size,2);
  await assert.rejects(a.putObject(id,new Uint8Array([4])));
  assert.deepEqual(await a.getObject(id),bytes);
});
