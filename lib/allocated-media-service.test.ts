// Protected owner/wrap service composition contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createAllocatedMediaService} from "./allocated-media-service";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const record={object,owner,issuedAt:100,sig:"signed-record"};
const bytes=new Uint8Array(33);bytes.set([0x73,0x33,0x6d,1]);
const digest=createHash("sha256").update(bytes).digest("hex");
function request(method:string,origin="https://s3r.ch"){
  return new Request("https://s3r.ch/api/media/"+object,{method,headers:{origin,
    ...(method==="POST"?{"content-type":"application/json"}:{}),
    ...(method==="PUT"?{"content-type":"application/octet-stream","content-length":"33","x-media-sha256":digest}:{})},
    body:method==="POST"?JSON.stringify(record):method==="PUT"?new Uint8Array(bytes):undefined});
}
test("registration confirms the native source without duplicate storage and reads use private wraps",async()=>{
  const actions:string[]=[];let uploads=0,wraps=0;
  const service=createAllocatedMediaService({origin:"https://s3r.ch",
    allocated:{reference:async()=>({digest,length:33}),get:async()=>bytes,put:async()=>{uploads++;}},
    owner:()=>async(action,input)=>{actions.push(action);assert.equal(input.headers.get("content-type"),"application/json");
      assert.deepEqual(await input.json(),action==="registration"?{object,record}:{object});return Response.json({accepted:true});},
    wrap:()=>async input=>{wraps++;assert.deepEqual(await input.json(),{object});return Response.json({});},
  });
  assert.equal((await service(request("POST"),object)).status,201);assert.equal(uploads,0);
  assert.deepEqual(actions,["view","registration","registration"]);
  assert.equal((await service(request("PUT"),object)).status,201);assert.equal(uploads,1);
  assert.equal((await service(request("GET"),object)).status,200);assert.equal(wraps,2);
  assert.equal((await service(request("DELETE"),object)).status,405);
});
test("missing authority and revoked source deny before and after storage",async()=>{
  let puts=0,reads=0;
  const allocated={reference:async()=>({digest,length:33}),get:async()=>{reads++;return bytes;},put:async()=>{puts++;}};
  const missing=createAllocatedMediaService({origin:"https://s3r.ch",allocated,owner:()=>null,wrap:()=>null});
  for(const method of ["POST","GET","PUT"])assert.equal((await missing(request(method),object)).status,403);
  assert.equal(puts+reads,0);
  let wrapCalls=0;
  const changed=createAllocatedMediaService({origin:"https://s3r.ch",allocated,
    owner:()=>async()=>new Response(null,{status:403}),
    wrap:()=>async()=>new Response(null,{status:++wrapCalls===1?200:403})});
  assert.equal((await changed(request("GET"),object)).status,403);assert.equal(reads,1);
  assert.equal((await changed(request("POST"),object)).status,403);
  assert.equal((await changed(request("PUT","https://evil.example"),object)).status,403);assert.equal(puts,0);
});
