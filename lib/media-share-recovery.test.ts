// Crypto, HTTP and IndexedDB contracts execute in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { sealMediaFile } from "./media-file";
import { createShareJournal, decryptShareJournal } from "./media-share-journal";
import { shareMedia, pendingMediaShare, abandonMediaShare } from "./media-share-recovery";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const reader="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
  epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111",signal=new AbortController().signal;
const target={object,owner,reader};
async function fixture(lost="",remove=false) {
  const journal=createShareJournal(new IDBFactory());
  const context={object,epoch:1,revisionId:"b".repeat(64)};
  const sealed=await sealMediaFile(new TextEncoder().encode("private file"),{name:"private.png",mediaType:"image/png"},
    {tenant,object},context,[{account:owner,pub:owner,identityPub:owner,epub:pair.epub}],[owner]);
  const reference={sha256:sealed.sha256,length:sealed.bytes.length};
  const grants=[owner,reader].map(accessor=>({object,owner,accessor,from:0,until:Number.MAX_SAFE_INTEGER,stated:remove&&accessor===reader?0:1,epoch:2,grantRevision:2,itemCiphertextDigest:sealed.sha256}));
  const snapshot={entries:grants.map(g=>({accessor:g.accessor,from:0,until:g.until,stated:g.stated,grantRevision:2,scope:"direct",setId:"",hamState:0}))};
  const bindings={[owner]:{pub:owner,epub:pair.epub,head:0},[reader]:{pub:reader,epub:reader,head:0}};
  if(remove)Reflect.deleteProperty(bindings,reader);
  const plan={at:100,fence:"a".repeat(64),owner,ownerPub:owner,reader,previousEpoch:1,previousFinalizationId:"d".repeat(64),grants,snapshot,bindings};
  const applied=new Map<string,unknown>(),writes:string[]=[];let failed=false,delay=false,conflict=false;
  const label=(op:string,p:any)=>op==="grant"?"grant:"+p.claims.accessor:op==="wrap"?"wrap:"+p.reader:op;
  const fetcher:typeof fetch=async(url,init)=>{
    const path=String(url),action=path.split("/").at(-1)!,body=typeof init?.body==="string"?JSON.parse(init.body):null;
    if(typeof init?.body==="string"){assert.ok(!init.body.includes(pair.priv));assert.ok(!init.body.includes(pair.epriv));}
    if(action==="read-wrap")return Response.json({context,readerEpub:pair.epub,expiresAt:Date.now()/1000+2,
      wrapBase64:Buffer.from(JSON.stringify({reference,wrap:sealed.wraps[0]})).toString("base64")});
    if(init?.method==="GET")return new Response(new Uint8Array(sealed.bytes),{headers:{"content-type":"application/octet-stream","content-length":String(sealed.bytes.length),etag:`"${sealed.sha256}"`}});
    if(action==="share-view"||action==="unshare-view")return Response.json(plan);
    if(action==="status-view"){
      if(delay&&applied.has("epoch"))return new Response(null,{status:403});
      return Response.json({at:100,fence:plan.fence,ownerPub:owner,status:{object,epoch:applied.has("epoch")?2:1,revisionId:"b".repeat(64),
        accessor:body.reader,grantRevision:2,stated:1,signedAt:100000,maxAgeMs:60000,zookie:{object,objectVersion:1,snapshotHash:"c".repeat(64)}}});
    }
    if(action==="view")return Response.json({at:100,fence:plan.fence,objectVersion:1,owner,snapshot,bindings});
    if(action==="share-check"){
      const key=label(body.operation,body.payload),held=applied.get(key);
      return Response.json({at:100,fence:plan.fence,state:conflict?"conflict":held?JSON.stringify(held)===JSON.stringify(body.payload)?"applied":"conflict":"absent"});
    }
    if(action==="mutate"&&body.operation==="status")return Response.json({accepted:true});
    assert.ok(await journal.read(signal),"recovery must precede every sharing mutation");
    const op=action==="publish-wrap"?"wrap":body.operation,payload=op==="wrap"?body.metadata:body.payload;
    const key=label(op,payload);applied.set(key,payload);writes.push(key);
    if(op===lost&&!failed){failed=true;throw Error("lost after commit");}
    return op==="wrap"?Response.json({record:payload.record,digest:payload.digest}):Response.json({accepted:true});
  };
  return {journal,fetcher,writes,delay:(v:boolean)=>{delay=v;},conflict:()=>{conflict=true;}};
}
test("sharing persists all signatures and wraps before publication and clears after confirmation",async()=>{
  const f=await fixture();assert.equal((await shareMedia({tenant,pair,signal,...f,target})).pending,false);
  assert.equal(f.writes.length,5);assert.equal(await f.journal.read(signal),null);
});
for(const lost of ["grant","epoch","wrap"])test(`lost ${lost} response reconciles exact saved intents`,async()=>{
  const f=await fixture(lost);
  if(lost==="wrap")assert.equal((await shareMedia({tenant,pair,signal,...f,target})).pending,true);
  else await assert.rejects(shareMedia({tenant,pair,signal,...f,target}));
  const entry=(await f.journal.read(signal))!;assert.ok(entry);
  assert.ok(!new TextDecoder().decode(entry.encrypted).includes(reader));
  assert.deepEqual(await pendingMediaShare(f.journal,tenant,pair,signal),{object,reader,token:entry.sha256});
  const saved=await decryptShareJournal(entry,tenant,pair);assert.ok(!JSON.stringify(saved).includes(pair.epriv));
  await assert.rejects(shareMedia({tenant,pair,signal,...f,target}),/Resume/);
  assert.equal((await shareMedia({tenant,pair,signal,...f,expected:(await pendingMediaShare(f.journal,tenant,pair,signal))??undefined})).pending,false);
  assert.equal(new Set(f.writes).size,f.writes.length);assert.equal(await f.journal.read(signal),null);
});
test("unsettled sharing remains recoverable and conflicts never replace signed changes",async()=>{
  const f=await fixture();f.delay(true);
  assert.equal((await shareMedia({tenant,pair,signal,...f,target})).pending,true);
  const count=f.writes.length;f.delay(false);f.conflict();
  await assert.rejects(shareMedia({tenant,pair,signal,...f,expected:(await pendingMediaShare(f.journal,tenant,pair,signal))??undefined}));assert.equal(f.writes.length,count);
  await assert.rejects(pendingMediaShare(f.journal,tenant,{...pair,epriv:pair.priv},signal));
  const entry=(await f.journal.read(signal))!;
  await assert.rejects(f.journal.write(entry,null,signal));await assert.rejects(f.journal.remove(entry.revision+1,signal));
  await assert.rejects(f.journal.read(AbortSignal.abort()));
});
test("journal refusal prevents grant, epoch and wrap publication",async()=>{
  const f=await fixture();const journal={...f.journal,write:async()=>{throw Error("storage full");}};
  await assert.rejects(shareMedia({tenant,pair,signal,fetcher:f.fetcher,journal,target}));assert.deepEqual(f.writes,[]);
  assert.equal(await pendingMediaShare(f.journal,tenant,pair,signal),null);
  await assert.rejects(shareMedia({tenant,pair,signal,...f,expected:(await pendingMediaShare(f.journal,tenant,pair,signal))??undefined}),/No pending/);
});

test("resume and abandonment bind the inspected draft, while abandonment leaves remote changes intact",async()=>{
  const f=await fixture("epoch");await assert.rejects(shareMedia({tenant,pair,signal,...f,target}));
  const expected=(await pendingMediaShare(f.journal,tenant,pair,signal))!,count=f.writes.length;
  for(const changed of [{...expected,reader:owner},{...expected,object:"other"},{...expected,token:"0".repeat(64)}]) {
    await assert.rejects(shareMedia({tenant,pair,signal,...f,expected:changed}));
    await assert.rejects(abandonMediaShare(f.journal,tenant,changed,pair,signal));
  }
  await assert.rejects(shareMedia({tenant,pair,signal,...f}));
  await abandonMediaShare(f.journal,tenant,expected,pair,signal);
  assert.equal(await f.journal.read(signal),null);assert.equal(f.writes.length,count);
});

test("unshare recovery retains cancellation and wraps only remaining readers",async()=>{
  const f=await fixture("epoch",true);
  await assert.rejects(shareMedia({tenant,pair,signal,...f,target:{...target,remove:true}}));
  const expected=(await pendingMediaShare(f.journal,tenant,pair,signal))!;assert.equal(expected.remove,true);
  const entry=(await f.journal.read(signal))!;
  const draft=await decryptShareJournal(entry,tenant,pair) as {grants:Array<{claims:{accessor:string;stated:number}}> ;prepared:{wraps:Array<{targetId:string}>}};
  assert.equal(draft.grants.find(g=>g.claims.accessor===reader)?.claims.stated,0);
  assert.deepEqual(draft.prepared.wraps.map(w=>w.targetId),[pair.epub]);
  assert.equal((await shareMedia({tenant,pair,signal,...f,expected})).pending,false);
  assert.deepEqual(f.writes,["grant:"+owner,"grant:"+reader,"epoch","wrap:"+owner]);
  assert.equal(await f.journal.read(signal),null);
});
