import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { createAzureRecordStore } from "./azure-record-store-server";
import { RECORD_BYTES_MAX, RecordConflict, type RecordNamespace } from "./record-store";
const tenant="11111111-1111-4111-8111-111111111111",bytes=new Uint8Array([0,255]);
const error=(statusCode:number,code:string)=>Object.assign(new Error("private credential"),{statusCode,code});
function fixture(){
  let data:Uint8Array|null=null,etag='"0"',counter=0,publicAccess:string|undefined;
  const paths:string[]=[],conditions:unknown[]=[];
  const blob={
    async getProperties(){if(!data)throw error(404,"BlobNotFound");return {etag};},
    async download(offset:number,count:number){assert.equal(offset,0);assert.equal(count,RECORD_BYTES_MAX+1);if(!data)throw error(404,"BlobNotFound");return {etag,contentLength:data.length,readableStreamBody:Readable.from([data])};},
    async upload(input:Uint8Array,length:number,options:any){
      conditions.push(options.conditions);
      assert.equal(length,input.length);assert.equal(options.blobHTTPHeaders.blobCacheControl,"private, no-store");
      if(options.conditions.ifNoneMatch==="*"&&data)throw error(409,"BlobAlreadyExists");
      if(options.conditions.ifMatch&&(!data||options.conditions.ifMatch!==etag))throw error(412,"ConditionNotMet");
      data=input.slice();etag='"'+String(++counter)+'"';return {etag};
    },
    async delete(options:any){conditions.push(options.conditions);if(!data)throw error(404,"BlobNotFound");if(options.conditions.ifMatch!==etag)throw error(412,"ConditionNotMet");data=null;},
  };
  const container={async getProperties(){return {blobPublicAccess:publicAccess};},getBlockBlobClient(path:string){paths.push(path);return blob;}};
  const store=createAzureRecordStore(container as unknown as ContainerClient,tenant);
  return {store,blob,container,paths,conditions,public:()=>{publicAccess="blob";}};
}

test("opaque records use tenant paths and atomic create/replace/delete conditions",async()=>{
  const f=fixture();assert.equal(await f.store.get("cache","feed"),null);
  const first=await f.store.put("cache","feed",bytes,null);
  assert.match(first,/^[0-9a-f]{64}$/);assert.deepEqual(await f.store.get("cache","feed"),{bytes,revision:first});
  await assert.rejects(f.store.put("cache","feed",bytes,null),RecordConflict);
  const second=await f.store.put("cache","feed",bytes,first);assert.notEqual(second,first,"identical payload still advances revision");
  await assert.rejects(f.store.put("cache","feed",bytes,first),RecordConflict);
  await assert.rejects(f.store.delete("cache","feed",first),RecordConflict);
  await f.store.delete("cache","feed",second);assert.equal(await f.store.get("cache","feed"),null);
  await assert.rejects(f.store.delete("cache","feed",second),RecordConflict);
  assert.ok(f.paths.every(p=>p===`s3rch-records/v1/${tenant}/cache/feed`));
  assert.deepEqual(f.conditions[0],{ifNoneMatch:"*"});
  assert.ok(f.conditions.some((c:any)=>c.ifMatch==='"1"'));
});

test("only one competing replacement commits and delete/recreate cannot reuse a revision",async()=>{
  const f=fixture(),first=await f.store.put("cache","feed",bytes,null);
  const outcomes=await Promise.allSettled([f.store.put("cache","feed",bytes,first),f.store.put("cache","feed",bytes,first)]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  const current=(await f.store.get("cache","feed"))!;await f.store.delete("cache","feed",current.revision);
  const recreated=await f.store.put("cache","feed",bytes,null);assert.notEqual(recreated,first);
  await assert.rejects(f.store.put("cache","feed",bytes,first),RecordConflict);
});

test("public containers and provider failures never expose credentials or become missing records",async()=>{
  const f=fixture();f.public();await assert.rejects(f.store.get("cache","feed"),{message:"Tenant record storage unavailable"});
  for(const cause of [error(404,"ContainerNotFound"),error(403,"AuthorizationFailure"),error(412,"LeaseIdMissing"),new Error("secret")]){
    const f=fixture();f.blob.download=async()=>{throw cause;};
    await assert.rejects(f.store.get("cache","feed"),{message:"Tenant record storage unavailable"});
  }
});

test("download validation cancels corrupt or oversized streams",async()=>{
  for(const patch of [{etag:undefined},{contentLength:0},{contentLength:3},{contentLength:1},{contentLength:RECORD_BYTES_MAX+1},{contentEncoding:"gzip"}]){
    const f=fixture(),stream=Readable.from([bytes]);
    f.blob.download=async()=>({etag:'"x"',contentLength:2,readableStreamBody:stream,...patch}) as any;
    await assert.rejects(f.store.get("cache","feed"));assert.equal(stream.destroyed,true);
  }
  const f=fixture();f.blob.download=async()=>({etag:'"x"',contentLength:2,readableStreamBody:Readable.from([new Uint8Array(RECORD_BYTES_MAX+1)])});
  await assert.rejects(f.store.get("cache","feed"));
  f.blob.download=async()=>({etag:'"x"',contentLength:2}) as any;await assert.rejects(f.store.get("cache","feed"));
});

test("invalid names, sizes, revisions, tenants and cancelled operations do not write",async()=>{
  const f=fixture();
  for(const name of ["../feed","","x".repeat(129)]){await assert.rejects(f.store.get("cache",name));await assert.rejects(f.store.put("cache",name,bytes,null));}
  await assert.rejects(f.store.get("secret" as RecordNamespace,"feed"));
  for(const input of [new Uint8Array(),new Uint8Array(RECORD_BYTES_MAX+1)])await assert.rejects(f.store.put("cache","feed",input,null));
  for(const revision of ["bad","A".repeat(64)]){await assert.rejects(f.store.put("cache","feed",bytes,revision));await assert.rejects(f.store.delete("cache","feed",revision));}
  await assert.rejects(f.store.put("cache","feed",bytes,null,AbortSignal.abort()));
  for(const id of ["bad","00000000-0000-0000-0000-000000000000"])assert.throws(()=>createAzureRecordStore(f.container as unknown as ContainerClient,id));
  assert.equal(f.conditions.length,0);
});

test("write/read metadata and delete races fail safely",async()=>{
  const f=fixture();
  await assert.rejects(f.store.put("cache","feed",bytes,"a".repeat(64)),RecordConflict);
  f.blob.upload=async()=>({etag:undefined}) as any;
  await assert.rejects(f.store.put("cache","feed",bytes,null));
  f.blob.getProperties=async()=>{throw error(403,"AuthorizationFailure");};
  await assert.rejects(f.store.delete("cache","feed","a".repeat(64)),{message:"Tenant record storage unavailable"});
  const g=fixture(),revision=await g.store.put("cache","feed",bytes,null);
  g.blob.delete=async()=>{throw error(404,"BlobNotFound");};
  await assert.rejects(g.store.delete("cache","feed",revision),RecordConflict);
  g.blob.delete=async()=>{throw error(403,"AuthorizationFailure");};
  await assert.rejects(g.store.delete("cache","feed",revision),{message:"Tenant record storage unavailable"});
});

test("upload copies mutable bytes before asynchronous provider checks",async()=>{
  const f=fixture(),input=bytes.slice();let finish!:()=>void;
  const ready=new Promise<void>(resolve=>{finish=resolve;});
  f.container.getProperties=async()=>{await ready;return {blobPublicAccess:undefined};};
  const writing=f.store.put("fixtures","sample",input,null);input.fill(0);finish();await writing;
  assert.deepEqual((await f.store.get("fixtures","sample"))?.bytes,bytes);
});
