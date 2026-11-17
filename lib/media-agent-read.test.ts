import test from "node:test";
import assert from "node:assert/strict";
import { createMediaAgentRead, type MediaAgent } from "./media-agent-read";
const principal="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const agent="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const identity={principal,agent,delegationId:"declared-delegation"};
const config={origin:"https://gateway.example",tenant:"11111111-1111-4111-8111-111111111111",
  readers:[{principal,apiKey:"owner-only"},{principal:agent,apiKey:"agent-only"}]};
const payload=(key:string)=>({context:{object,epoch:1,revisionId:"a".repeat(64)},
  readerEpub:key==="agent-only"?agent:principal,expiresAt:102,wrapBase64:key==="agent-only"?"YWdlbnQ=":"b3duZXI="});
const request=(body:unknown={object})=>new Request("https://s3r.ch/api/media/read-wrap",{method:"POST",
  headers:{origin:"https://s3r.ch","content-type":"application/json",authorization:"Bearer private"},body:JSON.stringify(body)});

test("independent ACL credentials intersect rights and only agent material is returned",async()=>{
  const keys:string[]=[];
  const service=createMediaAgentRead(config,"https://s3r.ch",async()=>identity,async(url,init)=>{
    assert.equal(String(url),"https://gateway.example/api/v1/acl/sociacl/media/read-wrap");
    assert.deepEqual(JSON.parse(String(init?.body)),{object});
    const key=new Headers(init?.headers).get("x-api-key")!; keys.push(key);
    return Response.json(payload(key));
  },()=>100);
  const response=await service(request());assert.equal(response.status,200);
  assert.deepEqual(await response.json(),payload("agent-only"));
  assert.deepEqual(keys,["owner-only","agent-only","owner-only"]);
  assert.match(response.headers.get("vary")!,/Authorization/);
});

test("denial for either subject and owner withdrawal during delivery withhold material",async()=>{
  for(const deniedCall of [1,2,3]) {
    let calls=0;
    const service=createMediaAgentRead(config,"https://s3r.ch",async()=>identity,async(_url,init)=>{
      if(++calls===deniedCall)return new Response(null,{status:403});
      return Response.json(payload(new Headers(init?.headers).get("x-api-key")!));
    },()=>100);
    const response=await service(request());assert.equal(response.status,403);assert.equal(await response.text(),"");
    assert.equal(calls,deniedCall);
  }
});

test("missing bindings, invalid bearer and forged reader never call the ACL provider",async()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json(payload("owner-only"));};
  for(const held of [config,{...config,readers:[config.readers[0]]}]) {
    const auth=held===config?async()=>null:async()=>identity;
    assert.equal((await createMediaAgentRead(held,"https://s3r.ch",auth,fetcher,()=>100)(request())).status,403);
  }
  const service=createMediaAgentRead(config,"https://s3r.ch",async()=>identity,fetcher,()=>100);
  assert.equal((await service(request({object,reader:principal}))).status,400);assert.equal(calls,0);
});

test("delegation revocation or replacement before final delivery is refused",async()=>{
  for(const replacement of [null,{...identity,delegationId:"replacement"},{...identity,principal:agent}]) {
    let calls=0;
    const authenticate=async():Promise<MediaAgent|null>=>calls>=2?replacement:identity;
    const service=createMediaAgentRead(config,"https://s3r.ch",authenticate,async(_url,init)=>{
      calls++;return Response.json(payload(new Headers(init?.headers).get("x-api-key")!));
    },()=>100);
    assert.equal((await service(request())).status,403);
  }
});

test("different object revision or expired owner observation cannot authorize agent delivery",async()=>{
  for(const expired of [false,true]) {
    let calls=0,now=100;
    const service=createMediaAgentRead(config,"https://s3r.ch",async()=>identity,async(_url,init)=>{
      calls++;const result=payload(new Headers(init?.headers).get("x-api-key")!);
      if(calls===3) {
        if(expired){now=101.5;result.expiresAt=103;}
        else result.context.revisionId="b".repeat(64);
      }
      return Response.json(result);
    },()=>{if(expired&&calls===3&&now===101.5){now=102;return 101.5;}return now;});
    assert.notEqual((await service(request())).status,200);
  }
});
