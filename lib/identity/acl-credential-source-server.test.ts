// Authenticated HTTP/history/native crypto contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, f } from "./fixtures/agent-delegation";
import { createAclCredentialSource } from "./acl-credential-source-server";
import { createLinkedSessionAdmission } from "./linked-session-admission";

async function fixture() {
  const h = await setup(), credential = {kind:"oidc" as const,...h.oidc.cred};
  const config = {origin:"https://acl.example",tenant:h.sourceConfig.tenant,source:"01234567-89ab-cdef-0123-456789abcdee",apiKey:"private-unit-key"};
  const history = structuredClone(h.document.snapshot.history); history.links = [h.oidc];
  const document = {version:1,tenant:config.tenant,source:config.source,authorityDigest:"a".repeat(64),trust:{untrusted:true},
    snapshot:{completeThrough:f.now,credential,links:[h.oidc] as unknown[],revocations:[] as unknown[],history}};
  let now=f.now, status=200;
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/credential-source/read");
    assert.equal(new Headers(options?.headers).get("X-Api-Key"),config.apiKey);
    assert.equal(options?.redirect,"error");assert.equal(options?.credentials,"omit");
    assert.deepEqual(JSON.parse(String(options?.body)),{credential,evaluatedAt:f.now});
    return Response.json(document,{status});
  };
  const source=createAclCredentialSource(config,h.trust,fetcher,()=>now);
  const admission=createLinkedSessionAdmission({source,origin:"https://s3r.ch",walletChainIds:[],oidc:[]});
  return {h,config,credential,document,source,admission,advance:()=>now++,offline:()=>status=503};
}
test("whole-domain source supplies the existing linked resolver using only local witness trust",async()=>{
  const h=await fixture();
  assert.equal((await h.admission.resolve(h.credential,f.now))?.key,h.h.oidc.principal);
  const first=await h.source.read(h.credential,f.now,new AbortController().signal);assert.ok(first);
  (first.context.jwks.keys as unknown[]).splice(0);
  assert.ok(await h.admission.resolve(h.credential,f.now));
});
test("foreign domain, stale, omitted candidates and broken histories refuse",async()=>{
  for(const mode of ["tenant","source","stale","credential","omitted","history","revocations","offline","clock"]){
    const h=await fixture();
    if(mode==="tenant")h.document.tenant=h.config.source;
    if(mode==="source")h.document.source=h.config.tenant;
    if(mode==="stale")h.document.snapshot.completeThrough--;
    if(mode==="credential")h.document.snapshot.credential.sub="foreign";
    if(mode==="omitted")h.document.snapshot.links=[];
    if(mode==="history")h.document.snapshot.history.accounts[0].genesisEpubBindings[0].keySig="bad";
    if(mode==="revocations")h.document.snapshot.revocations=[{}];
    if(mode==="offline")h.offline();
    if(mode==="clock")h.advance();
    assert.equal(await h.admission.resolve(h.credential,f.now),null,mode);
  }
});
test("aborted requests never perform IO",async()=>{
  const h=await fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(h.source.read(h.credential,f.now,controller.signal));
});
