// HTTP boundary contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { readGrantedMedia } from "./media-reader-catalog";
const principal="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const value={at:1,objects:[],nextPage:1,principal};
test("granted catalog uses a bounded page-only request",async()=>{
  const result=await readGrantedMedia(0,async(url,init)=>{
    assert.equal(url,"/api/media/catalog");assert.equal(init?.credentials,"same-origin");
    assert.equal(init?.redirect,"error");assert.equal(init?.cache,"no-store");
    assert.deepEqual(JSON.parse(String(init?.body)),{page:0});return Response.json(value);
  });assert.deepEqual(result,value);
});
test("invalid pages, replies, large bodies and cancellation refuse",async()=>{
  await assert.rejects(readGrantedMedia(-1,async()=>{throw Error("must not fetch");}));
  for(const response of [new Response(null,{status:403}),new Response("bad"),Response.json(null),Response.json([]),
    Response.json({...value,principal:"bad"}),Response.json({...value,extra:true}),Response.json({...value,nextPage:null}),
    Response.json({...value,objects:["media_bad"]}),new Response(" ".repeat(4097),{headers:{"content-type":"application/json"}})])
    await assert.rejects(readGrantedMedia(0,async()=>response));
  await assert.rejects(readGrantedMedia(0,async()=>Response.json(value),AbortSignal.abort()));
  const stopped=new AbortController();
  await assert.rejects(readGrantedMedia(0,async()=>{stopped.abort();return Response.json(value);},stopped.signal));
});
