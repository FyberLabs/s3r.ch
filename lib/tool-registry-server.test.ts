import test from "node:test";
import assert from "node:assert/strict";
import { createToolRegistryLookup, toolRegistryResponse } from "./tool-registry-server";
import { visorToolListings } from "./tool-registry";
const name="com.example/tool";
const document=()=>({server:{name,version:"1.2.3",description:"Example",remotes:[{type:"streamable-http",url:"https://uncontacted.invalid/mcp"}],packages:[{registryType:"npm",identifier:"example"}]},_meta:{"io.modelcontextprotocol.registry/official":{status:"active"}}});

test("only fixed official transport verifies catalog names, never installed instances", async()=>{
  let calls=0;
  const lookup=createToolRegistryLookup((async(url,init)=>{
    calls++;assert.equal(url,"https://registry.modelcontextprotocol.io/v0.1/servers/com.example%2Ftool/versions/latest");
    assert.equal(init?.redirect,"error");assert.equal(init?.credentials,"omit");assert.equal(init?.cache,"no-store");
    assert.deepEqual(Object.keys(init?.headers??{}).sort(),["Accept","Accept-Encoding"]);
    return Response.json(document());
  }) as typeof fetch);
  const row=(await lookup(name))!;assert.equal(calls,1);assert.equal(row.nameStatus,"registry-verified");
  assert.equal(row.kind,"web-and-local");assert.equal(row.authorization,"not-requested");assert.equal(row.safetyReview,"not-requested");
  assert.equal(JSON.stringify(row).includes("uncontacted.invalid"),false);
  const imported=visorToolListings(JSON.stringify({profile:"x",servers:[{name,transport:"http",tools:[]}]}),"visor")[0];
  assert.notEqual(imported.id,row.id);assert.equal(imported.nameStatus,"unverified");
});

test("unavailable, deprecated, mismatched and malicious metadata never verify a name",async()=>{
  for(const value of [null,{}, {...document(),server:{...document().server,name:"other/name"}}, {...document(),_meta:{"io.modelcontextprotocol.registry/official":{status:"deprecated"}}}, {...document(),_meta:{}}, {...document(),server:{...document().server,version:""}}]) {
    await assert.rejects(createToolRegistryLookup((async()=>Response.json(value)) as typeof fetch)(name),{message:"Registry lookup unavailable"});
  }
  for(const status of [301,403,429,500]) await assert.rejects(createToolRegistryLookup((async()=>new Response("private provider data",{status})) as typeof fetch)(name));
  assert.equal(await createToolRegistryLookup((async()=>new Response(null,{status:404})) as typeof fetch)(name),null);
  let calls=0;await assert.rejects(createToolRegistryLookup((async()=>{calls++;throw Error();}) as typeof fetch)("../bad"));assert.equal(calls,0);
});

test("reads are bounded, cancel oversized streams, and redact failures",async()=>{
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(256*1024+1));},cancel(){cancelled=true;}});
  await assert.rejects(createToolRegistryLookup((async()=>new Response(stream)) as typeof fetch)(name));assert.equal(cancelled,true);
  const invalidHeaders: Record<string,string>[] = [{"content-length":"9999999"},{"content-length":"1"},{"content-encoding":"gzip"}];
  for(const headers of invalidHeaders) await assert.rejects(createToolRegistryLookup((async()=>Response.json(document(),{headers})) as typeof fetch)(name));
  await assert.rejects(createToolRegistryLookup((async()=>{throw Error("secret-url");}) as typeof fetch)(name),{message:"Registry lookup unavailable"});
});

test("parallel registry lookups are capped and capacity recovers after failures",async()=>{
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const lookup=createToolRegistryLookup((async()=>{calls++;await wait;return new Response(null,{status:404});}) as typeof fetch);
  const pending=Array.from({length:4},()=>lookup(name));
  await assert.rejects(lookup(name),{message:"Registry busy"});assert.equal(calls,4);
  release();await Promise.all(pending);assert.equal(await lookup(name),null);
});

test("HTTP handler validates exact public queries and reports fixed errors",async()=>{
  let calls=0;const read=async()=>{calls++;return null;};
  for(const query of ["","name=a%2Fb&name=c%2Fd","name=a%2Fb&url=https://evil.invalid","name=..%2Fx"]) assert.equal((await toolRegistryResponse(new Request("https://s3r.ch/api/tools/registry?"+query),read)).status,400);
  assert.equal(calls,0);
  const missing=await toolRegistryResponse(new Request("https://s3r.ch/api/tools/registry?name=a%2Fb"),read);assert.equal(missing.status,404);assert.equal(missing.headers.get("cache-control"),"no-store");
  const failed=await toolRegistryResponse(new Request("https://s3r.ch/api/tools/registry?name=a%2Fb"),async()=>{throw Error("secret");});assert.equal(failed.status,503);assert.equal((await failed.text()).includes("secret"),false);
  const row=await createToolRegistryLookup((async()=>Response.json(document())) as typeof fetch)(name);
  assert.equal((await toolRegistryResponse(new Request("https://s3r.ch/api/tools/registry?name=a%2Fb"),async()=>row)).status,200);
});
