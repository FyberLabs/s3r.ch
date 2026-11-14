// Upload, crypto and storage contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { MediaQuotaExceeded } from "./media-client";
import { uploadMedia, pendingMediaUpload, discardMediaUpload } from "./media-upload";
import { createUploadJournal, decryptUploadJournal } from "./media-upload-journal";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
  epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const tenant="11111111-1111-4111-8111-111111111111",signal=new AbortController().signal;
const file=()=>({bytes:new TextEncoder().encode("private file bytes"),description:{name:"private.png",mediaType:"image/png"}});
function fixture(lost="") {
  const journal=createUploadJournal(new IDBFactory());
  let object="",allocated=false,failed=false,conflict=false;
  const applied=new Map<string,unknown>(),calls:string[]=[],writes:string[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    const path=String(url),action=path.split("/").at(-1)!;calls.push(action);
    const body=typeof init?.body==="string"?JSON.parse(init.body):null;
    if(typeof init?.body==="string") {assert.ok(!init.body.includes(pair.priv));assert.ok(!init.body.includes(pair.epriv));}
    if(action==="catalog")return Response.json({at:100,objects:[],nextPage:1,principal:owner});
    if(action==="view") {
      if(!allocated)return new Response(null,{status:403});
      const grant=applied.get("grant") as {claims:Record<string,unknown>}|undefined;
      const entries=grant?[Object.fromEntries(["accessor","grantRevision","stated","from","until"].map(k=>[k,grant.claims[k]]))]:[];
      return Response.json({at:100,fence:"a".repeat(64),objectVersion:applied.size,owner,
        snapshot:{entries:entries.map(row=>({...row,scope:"direct",setId:"",hamState:0}))},bindings:{[owner]:{pub:owner,epub:pair.epub,head:0}}});
    }
    if(action==="upload-state")return Response.json({at:100,state:conflict?"conflict":!applied.has(body.operation)?"absent":
      JSON.stringify(applied.get(body.operation))===JSON.stringify(body.payload)?"applied":"conflict"});
    let operation=action,result:Response;
    assert.ok(await journal.read(signal),"save encrypted recovery before every mutation");
    if(action==="allocate"){allocated=true;object=body.object;result=Response.json({object,accepted:true});}
    else if(action==="mutate"){operation=body.operation;applied.set(operation,body.payload);result=Response.json({accepted:true});}
    else if(action==="publish-wrap"){applied.set("wrap",body.metadata);result=Response.json({record:body.metadata.digest,digest:body.metadata.digest});}
    else if(init?.method==="POST"){operation="register";assert.equal(body.object,object);result=new Response(null,{status:201});}
    else {operation="put";assert.equal(init?.method,"PUT");assert.ok(init.body instanceof Uint8Array);assert.ok(!new TextDecoder().decode(init.body).includes("private file bytes"));result=new Response(null,{status:201});}
    writes.push(operation);
    if(operation===lost&&!failed){failed=true;throw Error("response lost after commit");}
    return result;
  };
  return {journal,fetcher,writes,calls,conflict:()=>{conflict=true;}};
}
test("private upload saves recovery before mutations and removes it only after ciphertext confirmation",async()=>{
  const f=fixture();const result=await uploadMedia({tenant,pair,signal,...f,file:file()});
  assert.match(result.object,/^media_p_/);assert.equal(await f.journal.read(signal),null);
  assert.deepEqual(f.writes,["allocate","grant","epoch","publish-wrap","register","put"]);
});
for(const lost of ["allocate","grant","epoch","publish-wrap","register","put"]){
  test(`lost ${lost} response resumes the same object and immutable signed intents`,async()=>{
    const f=fixture(lost);await assert.rejects(uploadMedia({tenant,pair,signal,...f,file:file()}));
    const entry=(await f.journal.read(signal))!;assert.ok(entry);
    assert.ok(!new TextDecoder().decode(entry.encrypted).includes("private.png"));
    const pending=await pendingMediaUpload(f.journal,tenant,pair,signal);assert.equal(pending?.name,"private.png");
    const draft=await decryptUploadJournal(entry,tenant,pair) as {fileKey:number[]};assert.equal(draft.fileKey.length,32);draft.fileKey.fill(0);
    await assert.rejects(uploadMedia({tenant,pair,signal,...f,file:file()}),/existing upload/);
    const result=await uploadMedia({tenant,pair,signal,...f});assert.equal(result.object,entry.object);
    assert.equal(f.writes.filter(x=>x==="allocate").length,1);
    assert.equal(f.writes.filter(x=>x==="grant").length,1);assert.equal(f.writes.filter(x=>x==="epoch").length,1);
    assert.equal(f.writes.filter(x=>x==="publish-wrap").length,1);
    assert.equal(await f.journal.read(signal),null);
  });
}
test("conflict, corrupt ciphertext and a foreign identity preserve recovery and stop writes",async()=>{
  const f=fixture("grant");await assert.rejects(uploadMedia({tenant,pair,signal,...f,file:file()}));
  const count=f.writes.length;f.conflict();await assert.rejects(uploadMedia({tenant,pair,signal,...f}));assert.equal(f.writes.length,count);
  await assert.rejects(pendingMediaUpload(f.journal,tenant,{...pair,epriv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"},signal));
  await assert.rejects(discardMediaUpload(f.journal,"22222222-2222-4222-8222-222222222222",(await f.journal.read(signal))!.object,pair,signal));
  const entry=(await f.journal.read(signal))!;entry.ciphertext[20]^=1;
  await f.journal.write(entry,entry.revision,signal);
  await assert.rejects(uploadMedia({tenant,pair,signal,...f}),/ciphertext changed/);assert.equal(f.writes.length,count);
  await discardMediaUpload(f.journal,tenant,entry.object,pair,signal);assert.equal(await f.journal.read(signal),null);
  await discardMediaUpload(f.journal,tenant,entry.object,pair,signal);assert.equal(await pendingMediaUpload(f.journal,tenant,pair,signal),null);
  await assert.rejects(uploadMedia({tenant,pair,signal,...f}),/No pending/);
});
test("storage refusal and cancellation prevent remote mutation",async()=>{
  const f=fixture();const bad={...f.journal,write:async()=>{throw Error("quota");}};
  await assert.rejects(uploadMedia({tenant,pair,signal,fetcher:f.fetcher,journal:bad,file:file()}));assert.deepEqual(f.writes,[]);
  const controller=new AbortController();
  await assert.rejects(uploadMedia({tenant,pair,signal:controller.signal,...f,file:file(),progress:message=>{
    if(message.startsWith("Confirming"))controller.abort();
  }}));assert.deepEqual(f.writes,[]);assert.ok(await f.journal.read(signal));
});
test("journal compare-and-swap prevents cross-tab overwrites and removes only the expected draft",async()=>{
  const f=fixture("allocate");await assert.rejects(uploadMedia({tenant,pair,signal,...f,file:file()}));
  const entry=(await f.journal.read(signal))!;
  await assert.rejects(f.journal.write(entry,null,signal));await assert.rejects(f.journal.remove(entry.revision+1,signal));
  await assert.rejects(f.journal.read(AbortSignal.abort()));assert.equal((await f.journal.read(signal))?.revision,entry.revision);
});

test("a stale discard confirmation cannot remove another window's newer draft",async()=>{
  const f=fixture("grant");await assert.rejects(uploadMedia({tenant,pair,signal,...f,file:file()}));
  const inspected=(await pendingMediaUpload(f.journal,tenant,pair,signal))!;
  await uploadMedia({tenant,pair,signal,...f});
  const abort=new AbortController();
  await assert.rejects(uploadMedia({tenant,pair,signal:abort.signal,...f,file:file(),progress:message=>{
    if(message.startsWith("Confirming"))abort.abort();
  }}));
  const replacement=(await f.journal.read(signal))!;assert.notEqual(replacement.object,inspected.object);
  await assert.rejects(discardMediaUpload(f.journal,tenant,inspected.object,pair,signal),/Pending upload changed/);
  assert.equal((await f.journal.read(signal))!.revision,replacement.revision);
  await discardMediaUpload(f.journal,tenant,replacement.object,pair,signal);
  assert.equal(await f.journal.read(signal),null);
});

test("remote quota refusal keeps the same encrypted upload for explicit retry", async () => {
  const f=fixture(); let refused=true;
  const fetcher:typeof fetch=async(url,init)=> {
    if(init?.method==="PUT" && refused)return new Response(null,{status:507});
    return f.fetcher(url,init);
  };
  await assert.rejects(uploadMedia({tenant,pair,signal,...f,fetcher,file:file()}),MediaQuotaExceeded);
  const pending=await f.journal.read(signal);assert.ok(pending);
  assert.equal(f.writes.filter(x=>x==="put").length,0);
  refused=false;
  const result=await uploadMedia({tenant,pair,signal,...f,fetcher});
  assert.equal(result.object,pending.object);
  assert.equal(f.writes.filter(x=>x==="allocate").length,1);
  assert.equal(f.writes.filter(x=>x==="put").length,1);
  assert.equal(await f.journal.read(signal),null);
});
