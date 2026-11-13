// Isolated configuration units; no HTTP, storage or signature operations.
import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionConfig } from "./agent-session-config";
const origin="https://s3r.ch";
const config=()=>({origin,source:{origin:"https://acl.example",tenant:"tenant",scope:"agents"},
  authority:{jwks:{keys:[{kty:"EC",crv:"P-256",kid:"witness",x:"x".repeat(43),y:"y".repeat(43),notBefore:0,notAfter:1}]},policy:{allowedDomains:[],allowedUris:[],allowedChainIds:[],clockSkewSeconds:0},pinnedIss:[]}});
const env=(value:unknown)=>({S3RCH_AGENT_SESSION_CONFIG:JSON.stringify(value),S3RCH_DELEGATION_SOURCE_API_KEY:"private-key"});
test("agent session configuration is absent by default and explicit when supplied",()=>{
  assert.equal(agentSessionConfig(origin,{}),undefined);
  const result=agentSessionConfig(origin,env(config()));assert.ok(result);
  assert.equal(result.source.apiKey,"private-key");assert.ok(result.trust.pinnedIss instanceof Set);
});
test("partial, oversized, duplicate and wrong-origin configurations deny",()=>{
  for(const value of [{S3RCH_DELEGATION_SOURCE_API_KEY:"private-key"},{S3RCH_AGENT_SESSION_CONFIG:"{}"},
    {...env(config()),S3RCH_AGENT_SESSION_CONFIG:" ".repeat(65537)},
    {...env(config()),S3RCH_AGENT_SESSION_CONFIG:'{"origin":"a","origin":"b"}'},env({...config(),origin:"https://foreign.example"}),env({})])
    assert.throws(()=>agentSessionConfig(origin,value));
});
test("invalid policy bounds and sources deny",()=>{
  for(const change of ["source","keys","skew","strings","issuer"]){
    const value=config();
    if(change==="source") value.source.scope="";
    if(change==="keys") value.authority.jwks.keys=[];
    if(change==="skew") value.authority.policy.clockSkewSeconds=301;
    if(change==="strings") (value.authority.policy.allowedUris as unknown[])=[null];
    if(change==="issuer") (value.authority.pinnedIss as unknown[])=["x".repeat(2049)];
    assert.throws(()=>agentSessionConfig(origin,env(value)));
  }
});

test("malformed and duplicate witness keys deny",()=>{
  for(const change of ["type","coordinates","time","duplicate","extra"]){
    const value=config(),key=value.authority.jwks.keys[0];
    if(change==="type") key.kty="RSA";
    if(change==="coordinates") key.x="bad";
    if(change==="time") key.notAfter=0;
    if(change==="duplicate") value.authority.jwks.keys.push({...key});
    if(change==="extra") Object.assign(key,{private:"forbidden"});
    assert.throws(()=>agentSessionConfig(origin,env(value)));
  }
});
