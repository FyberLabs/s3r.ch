import {test} from "node:test";
import assert from "node:assert/strict";
import {createIpfsMediaTransfer} from "./ipfs-media-transfer";
import {rawMediaBlockCid, IPFS_MEDIA_BLOCK_BYTES} from "./ipfs-media-blocks";
const binding = {tenant: "afee9b29-1706-5590-bbbf-e58df8945ac0", object: "claim_" + "12".repeat(32)};
function fixture() {
  const store = new Map<string, Uint8Array>(); let allowed = true, puts = 0, gets = 0;
  const abort = new AbortController();
  const blocks = {
    async put(bytes: Uint8Array) {puts++; const copy = new Uint8Array(bytes), cid = await rawMediaBlockCid(copy);store.set(cid,copy);return cid;},
    async get(cid: string) {gets++; const bytes=store.get(cid); if(!bytes)throw Error("missing"); return new Uint8Array(bytes);},
  };
  const options = {blocks,current:()=>allowed,signal:abort.signal};
  return {store,blocks,options,abort,revoke:()=>{allowed=false;},counts:()=>({puts,gets}),client:createIpfsMediaTransfer(options)};
}
test("multi-block encryption/upload/retrieval returns only authenticated plaintext", async () => {
  const f=fixture(), input=new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+7).fill(42);
  const grant=await f.client.upload(input,binding), manifest=JSON.parse(grant.manifest);
  assert.equal(manifest.blocks.length,2);assert.equal(grant.key.length,32);
  assert.equal(grant.manifest.includes('key'),false);
  assert.deepEqual(await f.client.download(grant.manifest,grant.key,binding),input);
  assert.deepEqual(f.counts(),{puts:2,gets:2});assert.ok(grant.key.some(byte=>byte!==0));
  assert.ok([...f.store.values()].some(bytes=>bytes.some(byte=>byte!==42)));
});
test("partial upload failure publishes no grant and does not retry", async () => {
  const f=fixture();let calls=0;const original=f.blocks.put;
  f.blocks.put=async bytes=>{if(++calls===2)throw Error("provider lost");return original(bytes);};
  await assert.rejects(f.client.upload(new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+1),binding));
  assert.equal(calls,2);assert.equal(f.store.size,1);
});
test("revocation stops between blocks and before returning plaintext", async () => {
  const f=fixture();const original=f.blocks.put;
  f.blocks.put=async bytes=>{const cid=await original(bytes);f.revoke();return cid;};
  await assert.rejects(f.client.upload(new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+1),binding));assert.equal(f.counts().puts,1);
  const g=fixture(),grant=await g.client.upload(new Uint8Array([1]),binding),get=g.blocks.get;
  g.blocks.get=async cid=>{const bytes=await get(cid);g.revoke();return bytes;};
  await assert.rejects(g.client.download(grant.manifest,grant.key,binding));
});
test("tampered blocks, key and binding cannot return plaintext", async () => {
  const f=fixture(),grant=await f.client.upload(new Uint8Array([1,2,3]),binding);
  await assert.rejects(f.client.download(grant.manifest,new Uint8Array(32),binding));
  await assert.rejects(f.client.download(grant.manifest,grant.key,{...binding,object:'claim_'+'34'.repeat(32)}));
  const cid=JSON.parse(grant.manifest).blocks[0];f.store.get(cid)![20]^=1;
  await assert.rejects(f.client.download(grant.manifest,grant.key,binding));
});
test("refuses malformed grant and cancelled operation without network", async () => {
  const f=fixture();await assert.rejects(f.client.download('{}',new Uint8Array(32),binding));
  f.abort.abort();await assert.rejects(f.client.upload(new Uint8Array([1]),binding));assert.deepEqual(f.counts(),{puts:0,gets:0});
});
test("snapshots download key/binding and refuses concurrent whole-media work", async () => {
  const f=fixture(),grant=await f.client.upload(new Uint8Array([1]),binding),bound={...binding};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),get=f.blocks.get;
  f.blocks.get=async cid=>{await gate;return get(cid);};
  const result=f.client.download(grant.manifest,grant.key,bound);
  grant.key.fill(0);bound.object='claim_'+'34'.repeat(32);
  await assert.rejects(f.client.upload(new Uint8Array([2]),binding));release();assert.deepEqual(await result,new Uint8Array([1]));
});

test("prepared upload resumes identical failed ciphertext without resending acknowledged blocks", async () => {
  const f=fixture(),input=new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+7).fill(7),original=f.blocks.put;
  const attempts:string[]=[];let fail=true;
  f.blocks.put=async bytes=>{attempts.push(await rawMediaBlockCid(bytes));if(attempts.length===2&&fail){fail=false;throw Error("lost");}return original(bytes);};
  const prepared=await f.client.prepareUpload(input,binding);
  assert.equal(prepared.status().state,"local-only");assert.equal(attempts.length,0);
  try {
    await assert.rejects(prepared.resume());
    assert.deepEqual(prepared.status(),{state:"unavailable",acknowledgedBlocks:1,totalBlocks:2});
    const grant=await prepared.resume();assert.equal(prepared.status().state,"acknowledged");
    assert.equal(attempts.length,3);assert.equal(attempts[1],attempts[2]);assert.notEqual(attempts[0],attempts[1]);
    assert.deepEqual(await f.client.download(grant.manifest,grant.key,binding),input);
    await assert.rejects(prepared.resume());assert.ok(grant.key.some(byte=>byte!==0));
  }finally{prepared.dispose();}
});
test("one prepared recording owns the composition until explicitly disposed", async () => {
  const f=fixture(),prepared=await f.client.prepareUpload(new Uint8Array([1]),binding);
  await assert.rejects(f.client.prepareUpload(new Uint8Array([2]),binding));
  await assert.rejects(f.client.upload(new Uint8Array([2]),binding));
  prepared.dispose();assert.equal(prepared.status().state,"disposed");await assert.rejects(prepared.resume());
  const grant=await f.client.upload(new Uint8Array([2]),binding);assert.equal(grant.key.length,32);
});
test("dispose during a pending acknowledgement prevents key release and clears retained block bytes", async () => {
  const f=fixture();let release!:(cid:string)=>void,received:Uint8Array|undefined;
  f.blocks.put=async bytes=>{received=bytes;return new Promise<string>(resolve=>{release=resolve;});};
  const prepared=await f.client.prepareUpload(new Uint8Array([1]),binding),pending=assert.rejects(prepared.resume());
  assert.ok(received);const cid=await rawMediaBlockCid(received!);
  await assert.rejects(prepared.resume());prepared.dispose();assert.ok(received!.every(byte=>byte===0));release(cid);await pending;
  assert.equal(prepared.status().state,"disposed");
});
test("abort, revoked consent and expiry terminate retained uploads without provider traffic", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  for(const reason of ["abort","revoke","expire"]){
    const f=fixture(),prepared=await f.client.prepareUpload(new Uint8Array([1]),binding);
    if(reason==="abort")f.abort.abort();else if(reason==="revoke")f.revoke();else t.mock.timers.tick(15*60_000);
    await assert.rejects(prepared.resume());assert.equal(prepared.status().state,reason==="expire"?"expired":"disposed");assert.equal(f.counts().puts,0);
  }
});
test("suspended or backwards monotonic clock expires retained upload on access", async t => {
  let now=100;t.mock.method(performance,"now",()=>now);
  const f=fixture(),prepared=await f.client.prepareUpload(new Uint8Array([1]),binding);
  now+=15*60_000;assert.equal(prepared.status().state,"expired");await assert.rejects(prepared.resume());
  const next=await f.client.prepareUpload(new Uint8Array([1]),binding);now--;assert.equal(next.status().state,"expired");
});

test("prepared download retains only CID-verified blocks and retries the failed block", async () => {
  const f=fixture(),input=new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+7).fill(9),grant=await f.client.upload(input,binding),get=f.blocks.get;
  const requests:string[]=[];f.blocks.get=async cid=>{requests.push(cid);if(requests.length===2)throw Error("offline");return get(cid);};
  const prepared=await f.client.prepareDownload(grant.manifest,grant.key,binding);
  try{
    assert.equal(requests.length,0);await assert.rejects(prepared.resume());
    assert.deepEqual(prepared.status(),{state:"unavailable",verifiedBlocks:1,totalBlocks:2});
    assert.deepEqual(await prepared.resume(),input);assert.equal(requests.length,3);assert.equal(requests[1],requests[2]);assert.notEqual(requests[0],requests[1]);
    assert.equal(prepared.status().state,"verified");await assert.rejects(prepared.resume());
  }finally{prepared.dispose();}
});
test("corrupted download block is not retained or counted on resume", async () => {
  const f=fixture(),grant=await f.client.upload(new Uint8Array([4]),binding),get=f.blocks.get;let corrupt=true;
  f.blocks.get=async cid=>{const bytes=await get(cid);if(corrupt)bytes[20]^=1;return bytes;};
  const prepared=await f.client.prepareDownload(grant.manifest,grant.key,binding);
  try{await assert.rejects(prepared.resume());assert.equal(prepared.status().verifiedBlocks,0);corrupt=false;assert.deepEqual(await prepared.resume(),new Uint8Array([4]));}finally{prepared.dispose();}
});
test("wrong decryption key terminates prepared download and releases its reservation", async () => {
  const f=fixture(),grant=await f.client.upload(new Uint8Array([4]),binding),prepared=await f.client.prepareDownload(grant.manifest,new Uint8Array(32),binding);
  await assert.rejects(prepared.resume());assert.equal(prepared.status().state,"disposed");
  assert.deepEqual(await f.client.download(grant.manifest,grant.key,binding),new Uint8Array([4]));
});
test("prepared download snapshots grant material and excludes competing whole-media work", async () => {
  const f=fixture(),grant=await f.client.upload(new Uint8Array([8]),binding),bound={...binding};
  const prepared=await f.client.prepareDownload(grant.manifest,grant.key,bound);
  try{
    grant.key.fill(0);bound.object='claim_'+'34'.repeat(32);
    await assert.rejects(f.client.prepareUpload(new Uint8Array([1]),binding));
    await assert.rejects(f.client.download(grant.manifest,grant.key,binding));
    assert.deepEqual(await prepared.resume(),new Uint8Array([8]));
  }finally{prepared.dispose();}
});
test("pending prepared download cannot release bytes after dispose or overlap another resume", async () => {
  const f=fixture(),grant=await f.client.upload(new Uint8Array([8]),binding),get=f.blocks.get;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.blocks.get=async cid=>{await gate;return get(cid);};
  const prepared=await f.client.prepareDownload(grant.manifest,grant.key,binding),pending=assert.rejects(prepared.resume());
  await assert.rejects(prepared.resume());prepared.dispose();release();await pending;assert.equal(prepared.status().state,"disposed");
});
test("prepared downloads expire or revoke without sending provider traffic", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  for(const reason of ["abort","revoke","expire"]){
    const f=fixture(),grant=await f.client.upload(new Uint8Array([8]),binding),prepared=await f.client.prepareDownload(grant.manifest,grant.key,binding);
    if(reason==="abort")f.abort.abort();else if(reason==="revoke")f.revoke();else t.mock.timers.tick(15*60_000);
    await assert.rejects(prepared.resume());assert.equal(prepared.status().state,reason==="expire"?"expired":"disposed");assert.equal(f.counts().gets,0);
  }
});

test("ordinary download stops at the first corrupt block and releases the operation for explicit retry",async()=>{
  for(const brokenIndex of [0,1]){
    const f=fixture(),input=new Uint8Array(2*IPFS_MEDIA_BLOCK_BYTES+7).fill(23);
    const grant=await f.client.upload(input,binding),manifest=JSON.parse(grant.manifest),original=f.blocks.get;
    const requests:string[]=[];let corrupt=true;
    f.blocks.get=async cid=>{requests.push(cid);const value=await original(cid);if(corrupt&&cid===manifest.blocks[brokenIndex])value[20]^=1;return value;};
    await assert.rejects(f.client.download(grant.manifest,grant.key,binding));
    assert.deepEqual(requests,manifest.blocks.slice(0,brokenIndex+1));
    corrupt=false;requests.length=0;
    assert.deepEqual(await f.client.download(grant.manifest,grant.key,binding),input);
    assert.deepEqual(requests,manifest.blocks);
  }
});
test("valid block CIDs still require the full recording digest before plaintext",async()=>{
  const f=fixture(),grant=await f.client.upload(new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+7).fill(42),binding);
  const manifest=JSON.parse(grant.manifest);manifest.sha256='0'.repeat(64);
  await assert.rejects(f.client.download(JSON.stringify(manifest),grant.key,binding));
  assert.equal(f.counts().gets,2);
});
test("authority withdrawal during block hashing prevents the next provider read",async t=>{
  const f=fixture(),grant=await f.client.upload(new Uint8Array(IPFS_MEDIA_BLOCK_BYTES+7).fill(42),binding);
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{const hash=await digest(...args);f.revoke();return hash;});
  await assert.rejects(f.client.download(grant.manifest,grant.key,binding));assert.equal(f.counts().gets,1);
});

test("invalid download bindings refuse both ordinary and prepared reads before provider work",async()=>{
  const f=fixture(),grant=await f.client.upload(new Uint8Array([1,2,3]),binding);
  const invalid=[null,undefined,{}, {...binding,tenant:'bad'}, {...binding,tenant:binding.tenant.toUpperCase()},
    {...binding,tenant:'00000000-0000-0000-0000-000000000000'}, {...binding,tenant:new String(binding.tenant)},
    {...binding,object:'unscoped'}, {...binding,object:new String(binding.object)}];
  for(const value of invalid){
    const bad=value as unknown as typeof binding;
    await assert.rejects(f.client.download(grant.manifest,grant.key,bad));
    await assert.rejects(f.client.prepareDownload(grant.manifest,grant.key,bad));
  }
  assert.equal(f.counts().gets,0);
  assert.deepEqual(await f.client.download(grant.manifest,grant.key,binding),new Uint8Array([1,2,3]));
});
test("prepared binding fields are captured once before admission and remain independent of caller mutation",async()=>{
  const f=fixture(),grant=await f.client.upload(new Uint8Array([7]),binding);let tenants=0,objects=0;
  const source={get tenant(){tenants++;return tenants===1?binding.tenant:'bad';},get object(){objects++;return objects===1?binding.object:'bad';}};
  const prepared=await f.client.prepareDownload(grant.manifest,grant.key,source);
  try {assert.equal(tenants,1);assert.equal(objects,1);assert.deepEqual(await prepared.resume(),new Uint8Array([7]));}
  finally{prepared.dispose();}
});
