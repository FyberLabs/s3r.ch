import { StatementSourceConflict } from "./acl-statement-source-server";
import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createSquadPilotServer, getSquadPilotServer, squadPilotReady } from "./squad-pilot-server";
import { parseSquadPilotConfig } from "./squad-pilot-config";
import { seaToPrincipalKey } from "./identity/forum-check";
const pub = p256.getPublicKey(Buffer.alloc(32, 53), false);
const x = Buffer.from(pub.slice(1,33)).toString("base64url"), y = Buffer.from(pub.slice(33)).toString("base64url"), owner = x+"."+y;
const witness = p256.getPublicKey(Buffer.alloc(32,56),false);
const wx=Buffer.from(witness.slice(1,33)).toString("base64url"), wy=Buffer.from(witness.slice(33)).toString("base64url");
const config = parseSquadPilotConfig(JSON.stringify({version:1, origin:"https://s3r.ch",
  squad:{forumId:`forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`,owner,label:"Fixture"},
  authority:{keys:[{kid:"fixture",kty:"EC",crv:"P-256",x:wx,y:wy,notBefore:0,notAfter:2000000000}],
    policy:{allowedDomains:[],allowedUris:[],allowedChainIds:[]},pinnedIssuers:[]}}))!;
const replay = { challengeDomain:"a".repeat(64), consume:async()=>false };
const snapshot = (at:number) => ({completeThrough:at,history:{completeThrough:at,accounts:[],links:[]},rows:[]});

test("ACL pilot reads one owner source and constructs no Blob or assignment stores", async () => {
  let reads = 0;
  const abort = new AbortController().signal;
  const statements = {read:async(at:number, signal:AbortSignal)=>{reads++;assert.equal(signal,abort);return {snapshot:snapshot(at),fence:"opaque"};},append:async()=>false};
  const server = createSquadPilotServer(config,statements,replay,()=>100,"s".repeat(32));
  assert.equal(server.backend,"acl");
  for (const retired of ["assignments", "challenge", "exchange", "logout"]) assert.equal(retired in server.services,false);
  assert.equal(typeof server.services.statements,"function");
  assert.deepEqual(await server.source.read(100,abort),snapshot(100));
  assert.equal(reads,1);
  statements.read = async()=>{throw Error("owner unavailable");};
  await assert.rejects(server.source.read(100,abort),/owner unavailable/);
});

test("ACL pilot refuses missing replay instead of constructing a Blob fallback", () => {
  const statements = {read:async()=>({snapshot:snapshot(100),fence:"opaque"}),append:async()=>false};
  assert.throws(()=>createSquadPilotServer(config,statements,undefined,()=>100,"s".repeat(32)),/requires configured identity replay/);
  assert.throws(()=>createSquadPilotServer(config,undefined,replay,()=>100,"s".repeat(32)),/statement source is required/);
});

test("deployment selection needs no Blob settings and rotates cached source configuration", () => {
  const values:Record<string,string|undefined> = {
    IDENTITY_SESSION_SECRET:"s".repeat(32),S3RCH_SQUAD_PILOT:JSON.stringify(config),
    S3RCH_SQUAD_BLOB_ACCOUNT:undefined,S3RCH_SQUAD_BLOB_CONTAINER:undefined,
    S3RCH_AUTHORITY_BACKEND:"acl",S3RCH_STATEMENT_SOURCE_ORIGIN:"https://acl.example.test",
    S3RCH_STATEMENT_SOURCE_TENANT_ID:"01234567-89ab-cdef-0123-456789abcdef",S3RCH_STATEMENT_SOURCE_SCOPE:"forum",
    S3RCH_STATEMENT_SOURCE_API_KEY:"statement-only",S3RCH_IDENTITY_REPLAY_BACKEND:"spanopticon",
    S3RCH_IDENTITY_REPLAY_ORIGIN:"https://storage.example.test",S3RCH_IDENTITY_REPLAY_TENANT_ID:"01234567-89ab-cdef-0123-456789abcdef",
    S3RCH_IDENTITY_REPLAY_API_KEY:"replay-only"};
  const saved = Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  const assign = (entries:Record<string,string|undefined>)=>{for(const [key,value] of Object.entries(entries)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}};
  try {
    assign(values);
    for (const backend of [undefined, "legacy"]) {
      assign({ S3RCH_AUTHORITY_BACKEND: backend, S3RCH_SQUAD_BLOB_ACCOUNT: "oldaccount", S3RCH_SQUAD_BLOB_CONTAINER: "old-pilot" });
      assert.throws(()=>getSquadPilotServer(),/statement source is required/);
    }
    assign(values);
    let server = getSquadPilotServer();assert.equal(server?.backend,"acl");assert.equal(getSquadPilotServer(),server);
    for (const [key,value] of Object.entries({S3RCH_STATEMENT_SOURCE_ORIGIN:"https://new.example.test",
      S3RCH_STATEMENT_SOURCE_TENANT_ID:"01234567-89ab-cdef-0123-456789abcdea",S3RCH_STATEMENT_SOURCE_SCOPE:"other",
      S3RCH_STATEMENT_SOURCE_API_KEY:"replacement"})) {
      process.env[key]=value;
      if(key==="S3RCH_STATEMENT_SOURCE_TENANT_ID") process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID=value;
      const next=getSquadPilotServer();assert.notEqual(next,server);server=next;
    }
    process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID="01234567-89ab-cdef-0123-456789abcdef";
    assert.throws(()=>getSquadPilotServer(),/same tenant/);
    process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID=process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID;
    delete process.env.S3RCH_STATEMENT_SOURCE_API_KEY;
    assert.throws(()=>getSquadPilotServer(),/not configured/);
    process.env.S3RCH_STATEMENT_SOURCE_API_KEY="replacement";
    for (const key of Object.keys(values).filter(key=>key.startsWith("S3RCH_IDENTITY_REPLAY_"))) delete process.env[key];
    assert.throws(()=>getSquadPilotServer(),/same tenant/);
  } finally { assign(saved); }
});


test("readiness only retries a source conflict after the evaluation second changes", async () => {
  let at=100, reads=0;
  const source={read:async()=>{reads++;throw new StatementSourceConflict();}};
  assert.equal(await squadPilotReady({config,source},new AbortController().signal,()=>at),false);
  assert.equal(reads,1);
  source.read=async()=>{reads++;if(reads===2){at++;throw new StatementSourceConflict();}throw Error("fresh source still unavailable");};
  await assert.rejects(squadPilotReady({config,source},new AbortController().signal,()=>at),/fresh source still unavailable/);
  assert.equal(reads,3);
});
