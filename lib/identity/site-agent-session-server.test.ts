// HTTP, replay and cryptographic contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, f } from "./fixtures/agent-delegation";
import { siteAgentSession, authenticateAgentRequest } from "./site-agent-session-server";
import { signForumRecord } from "../forum-sign";
const origin="https://s3r.ch";
const request=(action:string,body:unknown,headers:Record<string,string>={})=>new Request(origin+"/api/identity/agent/"+action,
  {method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
async function harness() {
  const fixture=await setup(), used=new Set<string>(); let reads=0;
  const env:Record<string,string|undefined>={IDENTITY_SESSION_SECRET:"s".repeat(32),S3RCH_DELEGATION_SOURCE_API_KEY:fixture.sourceConfig.apiKey,
    S3RCH_AGENT_SESSION_CONFIG:JSON.stringify({origin,source:{origin:fixture.sourceConfig.origin,tenant:fixture.sourceConfig.tenant,scope:"agents"},
      authority:{jwks:fixture.trust.jwks,policy:{...fixture.trust.policy,clockSkewSeconds:0},pinnedIss:[...fixture.trust.pinnedIss]}}),
    S3RCH_IDENTITY_REPLAY_BACKEND:"spanopticon",S3RCH_IDENTITY_REPLAY_ORIGIN:"https://gateway.example",
    S3RCH_IDENTITY_REPLAY_TENANT_ID:fixture.sourceConfig.tenant,S3RCH_IDENTITY_REPLAY_API_KEY:"private-replay-key"};
  const fetcher:typeof fetch=async(url,options)=>{
    const path=String(url); assert.equal(options?.redirect,"error");
    if(path.startsWith("https://acl.example/api/v1/acl/sociacl/delegations/agents/")) {
      reads++; return Response.json(fixture.document);
    }
    assert.ok(path.startsWith("https://gateway.example/api/v1/storage/replays/"));
    if(used.has(path)) return new Response(null,{status:409});
    used.add(path);return new Response(null,{status:204});
  };
  const call=(action:string,body:unknown,headers:Record<string,string>={})=>siteAgentSession(request(action,body,headers),action,env,fetcher,()=>f.now);
  return {...fixture,env,fetcher,call,reads:()=>reads};
}
test("native agent challenge exchanges once and every bearer use rechecks cancellation",async()=>{
  const h=await harness();
  const response=await h.call("challenge",{delegationId:h.id,scopes:["forum:read"]});assert.equal(response.status,200);
  assert.equal(response.headers.get("set-cookie"),null);
  const {challenge}=await response.json(),signature=await signForumRecord(challenge,h.agentPair);assert.ok(signature);
  const exchange=await h.call("exchange",{challenge,signature});assert.equal(exchange.status,200);
  assert.equal(exchange.headers.get("set-cookie"),null);assert.match(exchange.headers.get("cache-control")!,/no-store/);
  const {token}=await exchange.json();
  assert.equal((await h.call("exchange",{challenge,signature})).status,403);
  const req=new Request(origin+"/api/rooms",{headers:{Authorization:"Bearer "+token}});
  assert.ok(await authenticateAgentRequest(req,["forum:read"],h.env,h.fetcher,()=>f.now));
  assert.equal(await authenticateAgentRequest(req,["forum:write"],h.env,h.fetcher,()=>f.now),null);
  const before=h.reads();h.document.snapshot.rows.push({kind:"revocation",record:h.revocation});
  assert.equal(await authenticateAgentRequest(req,["forum:read"],h.env,h.fetcher,()=>f.now),null);assert.ok(h.reads()>before);
});
test("disabled or cross-tenant configuration never calls providers",async()=>{
  const h=await harness();let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error("unexpected");};
  for(const env of [{},{...h.env,S3RCH_IDENTITY_REPLAY_TENANT_ID:"01234567-89ab-cdef-0123-456789abcdee"},
    {...h.env,S3RCH_IDENTITY_REPLAY_BACKEND:undefined},{...h.env,IDENTITY_SESSION_SECRET:undefined}])
    assert.equal((await siteAgentSession(request("challenge",{delegationId:h.id,scopes:["forum:read"]}),"challenge",env,fetcher,()=>f.now)).status,503);
  assert.equal(calls,0);
});
test("cross-origin, malformed, oversized and unsupported requests deny",async()=>{
  const h=await harness();
  assert.equal((await h.call("other",{})).status,404);
  assert.equal((await h.call("challenge",{}, {Origin:"https://foreign.example"})).status,503);
  assert.equal((await h.call("challenge",{delegationId:h.id,scopes:["forum:read"],history:{}})).status,400);
  assert.equal((await h.call("exchange",{challenge:1,signature:"bad"})).status,400);
  assert.equal((await h.call("exchange",{challenge:"x".repeat(50000),signature:"bad"})).status,503);
  assert.equal((await h.call("exchange",{challenge:"bad",signature:"bad"})).status,403);
  assert.equal((await h.call("challenge",{}, {"Content-Encoding":"gzip"})).status,503);
  assert.equal(await authenticateAgentRequest(new Request(origin),["forum:read"],h.env,h.fetcher,()=>f.now),null);
  assert.equal(h.reads(),0);
});
