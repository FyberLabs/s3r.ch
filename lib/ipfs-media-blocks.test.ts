import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sealMedia, openMedia, MEDIA_STORED_MAX } from "./media-crypto";
import { rawMediaBlockCid, describeMediaBlocks, parseMediaBlockManifest, assembleMediaBlocks, IPFS_MEDIA_BLOCK_BYTES as SIZE } from "./ipfs-media-blocks";
const binding = {tenant:"afee9b29-1706-5590-bbbf-e58df8945ac0", object:"claim_"+"12".repeat(32)};
const chunks = (bytes:Uint8Array) => Array.from({length:Math.ceil(bytes.length/SIZE)},(_,i)=>bytes.slice(i*SIZE,(i+1)*SIZE));
// Independent base32 conversion of the CID spec's raw "hello" binary vector.
const hello = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
test("raw block CID matches the IPFS specification vector",async()=>{
 assert.equal(await rawMediaBlockCid(new TextEncoder().encode("hello")),hello);
 await assert.rejects(rawMediaBlockCid(new Uint8Array()));
 await assert.rejects(rawMediaBlockCid(new Uint8Array(SIZE+1)));
});
test("real encrypted multiblock media round trips without exposing keys in manifest",async()=>{
 const plain=new Uint8Array(SIZE+53);plain.fill(37);
 const sealed=await sealMedia(plain,binding), manifest=await describeMediaBlocks(sealed.bytes);
 assert.equal(manifest.blocks.length,2);assert.equal(manifest.sha256,sealed.sha256);
 assert.deepEqual(Object.keys(manifest).sort(),["blocks","bytes","sha256","version"]);
 assert.ok(Object.isFrozen(manifest)&&Object.isFrozen(manifest.blocks));
 const result=await assembleMediaBlocks(JSON.stringify(manifest),chunks(sealed.bytes));
 assert.deepEqual(await openMedia(result,sealed.sha256,sealed.key,binding),plain);
 await assert.rejects(openMedia(result,sealed.sha256,sealed.key,{...binding,object:"claim_"+"34".repeat(32)}));
});
test("manifest refuses codecs, noncanonical encodings, sizes and extra private fields",()=>{
 const good={version:1,bytes:33,sha256:"a".repeat(64),blocks:[hello]};
 assert.equal(parseMediaBlockManifest(JSON.stringify(good)).bytes,33);
 const bad=[{...good,key:"secret"},{...good,version:2},{...good,bytes:0},{...good,bytes:MEDIA_STORED_MAX+1},
 {...good,bytes:SIZE+1},{...good,sha256:"A".repeat(64)},...['Qm'+'a'.repeat(44),hello.toUpperCase(),hello+'a',hello.slice(0,-1)+'r',hello.replace('bafk','bafy'),'https://gateway/'+hello].map(cid=>({...good,blocks:[cid]}))];
 for(const row of bad) assert.throws(()=>parseMediaBlockManifest(JSON.stringify(row)));
 for(const value of ['null','[]','{',' '.repeat(16385)])assert.throws(()=>parseMediaBlockManifest(value));
});
test("tampered, missing, extra, reordered and truncated blocks fail before output",async()=>{
 const sealed=await sealMedia(new Uint8Array(SIZE+1),binding), manifest=await describeMediaBlocks(sealed.bytes), blocks=chunks(sealed.bytes), json=JSON.stringify(manifest);
 const corrupt=blocks.map(b=>b.slice());corrupt[0][40]^=1;
 for(const input of [corrupt,blocks.slice(1),[...blocks,blocks[0]],[blocks[1],blocks[0]],[blocks[0],blocks[1].slice(1)]])await assert.rejects(assembleMediaBlocks(json,input));
 await assert.rejects(assembleMediaBlocks(JSON.stringify({...manifest,sha256:'0'.repeat(64)}),blocks));
});
test("all caller bytes are snapshotted before asynchronous hashing",async()=>{
 const sealed=await sealMedia(new Uint8Array(SIZE+4),binding), original=sealed.bytes.slice();
 const describing=describeMediaBlocks(sealed.bytes);sealed.bytes.fill(0);const manifest=await describing;
 assert.equal(manifest.sha256,createHash('sha256').update(original).digest('hex'));
 const blocks=chunks(original), assembling=assembleMediaBlocks(JSON.stringify(manifest),blocks);blocks.forEach(b=>b.fill(0));
 assert.deepEqual(await assembling,original);
});
test("non-envelope payloads and unsupported versions cannot be described",async()=>{
 await assert.rejects(describeMediaBlocks(new Uint8Array(33)));
 await assert.rejects(describeMediaBlocks(new Uint8Array(32)));
 const sealed=await sealMedia(new Uint8Array([1]),binding);sealed.bytes[3]=2;
 await assert.rejects(describeMediaBlocks(sealed.bytes));
});
test("equal-sized swapped blocks fail their ordered CID checks",async()=>{
 const plain=new Uint8Array(SIZE*2);plain.fill(1,0,SIZE);plain.fill(2,SIZE);
 const sealed=await sealMedia(plain,binding), manifest=await describeMediaBlocks(sealed.bytes), blocks=chunks(sealed.bytes);
 [blocks[0],blocks[1]]=[blocks[1],blocks[0]];
 await assert.rejects(assembleMediaBlocks(JSON.stringify(manifest),blocks));
});
test("maximum manifest is bounded and accepts exactly 64 block references",()=>{
 const manifest={version:1,bytes:MEDIA_STORED_MAX,sha256:'a'.repeat(64),blocks:Array(64).fill(hello)};
 assert.equal(parseMediaBlockManifest(JSON.stringify(manifest)).blocks.length,64);
 assert.throws(()=>parseMediaBlockManifest(JSON.stringify({...manifest,blocks:Array(65).fill(hello)})));
});
