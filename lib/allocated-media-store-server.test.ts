// Storage HTTP contracts execute in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createAllocatedMediaStore} from "./allocated-media-store-server";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const config={origin:"https://storage.example",tenant:"11111111-1111-4111-8111-111111111111",apiKey:"private-key"};
const bytes=new Uint8Array(33),digest=createHash("sha256").update(bytes).digest("hex");
const signal=()=>new AbortController().signal;
const binary=(data:Uint8Array=bytes,headers:Record<string,string>={})=>new Response(new Uint8Array(data),{
  headers:{"content-length":String(bytes.length),etag:'"'+digest+'"',...headers}});
test("allocated storage uses fixed credentials and immutable object reference",async()=>{
  const calls:string[]=[];
  const store=createAllocatedMediaStore(config,async(url,init)=>{
    calls.push(String(url));assert.equal(init?.redirect,"error");assert.equal(init?.credentials,"omit");
    const headers=new Headers(init?.headers);assert.equal(headers.get("x-api-key"),config.apiKey);assert.equal(headers.get("x-tenant-id"),config.tenant);
    if(init?.method==="PUT"){assert.equal(headers.get("x-media-owner"),owner);assert.equal(headers.get("content-length"),"33");return new Response(null,{status:204,headers:{etag:'"'+digest+'"'}});}
    if(String(url).endsWith("/ciphertext"))return Response.json({sha256:digest,length:33});
    return binary();
  });
  assert.deepEqual(await store.reference(object,signal()),{digest,length:33});
  assert.deepEqual(await store.get(object,digest,signal()),bytes);
  await store.put(object,digest,bytes,signal());
  assert.deepEqual(calls,[config.origin+"/api/v1/storage/media/payloads/"+object+"/ciphertext",
    ...Array(2).fill(config.origin+"/api/v1/storage/media/payloads/"+object+"/ciphertext/"+digest)]);
});
test("configuration and invalid addresses never call transport",async()=>{
  for(const changes of [{origin:"http://storage.example"},{origin:"https://user:pass@storage.example"},{origin:"https://storage.example/path"},
    {origin:"https://storage.example:4433"},{origin:"https://storage.example?x=y"},{origin:"https://storage.example/#x"},
    {tenant:"bad"},{tenant:"00000000-0000-0000-0000-000000000000"},{apiKey:""},{apiKey:"key\n"}])
    assert.throws(()=>createAllocatedMediaStore({...config,...changes}));
  let calls=0;const store=createAllocatedMediaStore(config,async()=>{calls++;return binary();});
  await assert.rejects(store.reference("bad",signal()));await assert.rejects(store.get(object,"bad",signal()));
  await assert.rejects(store.put(object,digest,new Uint8Array(32),signal()));
  const wrong=new Uint8Array(bytes);wrong[0]=1;await assert.rejects(store.put(object,digest,wrong,signal()));
  const abort=new AbortController();abort.abort();await assert.rejects(store.reference(object,abort.signal));assert.equal(calls,0);
});
test("reference lookup distinguishes absence and rejects malformed successes",async()=>{
  assert.equal(await createAllocatedMediaStore(config,async()=>new Response(null,{status:404})).reference(object,signal()),null);
  for(const response of [new Response("private",{status:403}),new Response("not json"),Response.json(null),Response.json([]),
    Response.json({sha256:digest,length:33,extra:true}),Response.json({sha256:"bad",length:33}),Response.json({sha256:digest,length:32}),
    Response.json({sha256:digest,length:67108865}),Response.json({sha256:digest,length:33},{headers:{"content-encoding":"gzip"}})])
    await assert.rejects(createAllocatedMediaStore(config,async()=>response).reference(object,signal()),/^Error: Allocated media storage unavailable$/);
});
test("downloads and upload acknowledgements must match bounded bytes",async()=>{
  for(const response of [new Response(null,{status:404}),binary(bytes,{etag:'"wrong"'}),binary(bytes,{"content-encoding":"gzip"}),
    binary(bytes,{"content-length":"0"}),binary(bytes,{"content-length":"67108865"}),binary(new Uint8Array(34)),
    binary(new Uint8Array(32)),binary(new Uint8Array(33).fill(1)),new Response(null,{headers:{"content-length":"33",etag:'"'+digest+'"'}})])
    await assert.rejects(createAllocatedMediaStore(config,async()=>response).get(object,digest,signal()));
  for(const response of [new Response(null,{status:403}),new Response(null,{status:201,headers:{etag:'"wrong"'}})])
    await assert.rejects(createAllocatedMediaStore(config,async()=>response).put(object,digest,bytes,signal()));
  const store=createAllocatedMediaStore(config,async()=>new Response(null,{status:201,headers:{etag:'"'+digest+'"'}}));
  await store.put(object,digest,bytes,signal());
});
