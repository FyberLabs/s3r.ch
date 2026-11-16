// Native SEA/Check cryptography; protected HTTP and replay persistence are unit doubles.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { generateKeyPairSync, verify, createPrivateKey, createHmac, sign } from "node:crypto";
import { createStreamAuthority, streamCanonical } from "./stream-authority-server";
import { createIdentitySessions } from "./identity/sea-session";
import { signForumRecord } from "./forum-sign";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import type { SeaPair } from "./identity/sea";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const tenant="11111111-1111-4111-8111-111111111111";
async function setup() {
  const owner=await sea.pair(), viewer=await sea.pair(), outsider=await sea.pair();
  let now=1700000060, stale=false, reads=0;
  let beforeRead: (() => Promise<void>) | undefined;
  const forum=`forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`;
  const room=`room_${seaToPrincipalKey(owner.pub)}_${"b".repeat(32)}`;
  const rows: ForumAuthoritySnapshot["rows"][number][]=[];
  function record(kind: AuthorityKind, fields: Record<string,unknown>) {
    const value={...fields,issuedAt:now,sig:"pending"}, parsed=parseForumAuthority(kind,value);assert.ok(parsed);
    const [x,y]=owner.pub.split(".");
    const key=createPrivateKey({format:"jwk",key:{kty:"EC",crv:"P-256",x,y,d:owner.priv}});
    value.sig=sign("sha256",parsed.bytes,{key,dsaEncoding:"ieee-p1363"}).toString("base64url");
    rows.push({kind,soul:parsed.soul,record:value});
  }
  for(const object of [forum,room]) {
    record("object",{object,owner:owner.pub});
    record("see",{object,owner:owner.pub,accessor:viewer.pub,from:now,until:now+600,stated:1,hamState:now});
  }
  const key=generateKeyPairSync("ed25519");
  const fetcher: typeof fetch=async (url,init) => {
    reads++; await beforeRead?.(); assert.equal(String(url),"https://acl.example/api/v1/acl/sociacl/statements/stream/snapshot");
    assert.equal(new Headers(init?.headers).get("X-Tenant-ID"),tenant);
    const at=JSON.parse(String(init?.body)).evaluatedAt-(stale?1:0);
    return Response.json({fence:"a".repeat(64),snapshot:{completeThrough:at,
      history:{completeThrough:at,links:[],accounts:[owner,viewer,outsider].map(pair=>({principal:pair.pub,rotations:[],revocations:[],genesisEpubBindings:[]}))},rows}});
  };
  const handler=createStreamAuthority({tenant,forum,origin:"https://s3r.ch",sessionSecret:"s".repeat(32),
    serviceKey:"c".repeat(32),signingKey:key.privateKey,source:{origin:"https://acl.example",tenant,scope:"stream",apiKey:"fixture-key"},
    authority:{keys:[],policy:{allowedDomains:[],allowedUris:[],allowedChainIds:[]},pinnedIssuers:[]}},fetcher,()=>now);
  const used=new Set<string>();
  const sessions=createIdentitySessions({origin:"https://s3r.ch",secret:"s".repeat(32),clock:()=>now,
    consume:async id=>{if(used.has(id))return false;used.add(id);return true;}});
  async function token(pair:SeaPair) {
    const challenge=await sessions.challenge(pair.pub), signature=await signForumRecord(challenge,pair);assert.ok(signature);
    const result=await sessions.exchange(challenge,signature);assert.ok(result);return result;
  }
  async function call(operation:string, extra:object={}, bearer?:string, serviceKey="c".repeat(32)) {
    return handler(new Request("https://owner.example/internal/streams/authority",{method:"POST",
      headers:{"Content-Type":"application/json","X-Stream-Service-Key":serviceKey,...(bearer?{Authorization:"Bearer "+bearer}:{})},
      body:JSON.stringify({version:1,operation,nonce:"f".repeat(64),...extra})}));
  }
  const scope=(principal:string,action="read")=>({subject:{tenant,principal},room,action,ip:"192.0.2.1"});
  async function subject(pair:SeaPair) {const response=await call("identity",{},await token(pair));assert.equal(response.status,200);return (await response.json()).claims.principal as string;}
  return {call,subject,scope,owner,viewer,outsider,key,record,room,forum,handler,
    advance:(n:number)=>{now+=n;},stale:()=>{stale=true;},reads:()=>reads, beforeRead:(fn:()=>Promise<void>)=>{beforeRead=fn;}};
}
test("native identity and signed current room Check bind Core scope and session expiry",async()=>{
  const h=await setup(), principal=await h.subject(h.owner), scope=h.scope(principal,"publish");
  assert.ok(principal.length<=256);
  const response=await h.call("check",{scope});assert.equal(response.status,200);
  const result=await response.json();assert.deepEqual(result.claims.scope,scope);
  assert.equal(result.claims.validUntil,1700000360);
  assert.ok(verify(null,Buffer.from("core-stream-authority-v1\0"+streamCanonical(result.claims)),h.key.publicKey,Buffer.from(result.signature,"base64")));
  h.advance(300);assert.equal((await h.call("check",{scope})).status,403);
});
test("viewer cannot publish and current signed cancellation terminates read authority",async()=>{
  const h=await setup(), principal=await h.subject(h.viewer), scope=h.scope(principal);
  assert.equal((await h.call("check",{scope})).status,200);
  assert.equal((await h.call("check",{scope:h.scope(principal,"publish")})).status,403);
  h.record("see",{object:h.room,owner:h.owner.pub,accessor:h.viewer.pub,from:1700000060,until:1700000660,stated:0,hamState:1700000061});
  assert.equal((await h.call("check",{scope})).status,403);
  assert.ok(h.reads()>=4);
});
test("forged, cross-tenant, stale, ungranted and unauthenticated requests deny",async()=>{
  const h=await setup(), principal=await h.subject(h.owner), scope=h.scope(principal);
  assert.equal((await h.call("identity",{},"forged")).status,403);
  assert.equal((await h.call("check",{scope:{...scope,subject:{tenant,principal:principal+"x"}}})).status,403);
  assert.equal((await h.call("check",{scope:{...scope,subject:{tenant:"22222222-2222-4222-8222-222222222222",principal}}})).status,403);
  assert.equal((await h.call("check",{scope},undefined,"wrong")).status,403);
  await assert.rejects(h.subject(h.outsider));
  const payload=`s1.${h.owner.pub}.1700000360.${"a".repeat(64)}`;
  const forged=payload+"."+createHmac("sha256","c".repeat(32)).update("s3rch-stream-subject-v1\0"+tenant+"\0"+payload).digest("base64url");
  assert.equal((await h.call("check",{scope:h.scope(forged,"publish")})).status,403);
  h.stale();assert.equal((await h.call("check",{scope})).status,403);
});
test("private owner refuses oversized and wrong-shape requests",async()=>{
  const h=await setup();
  assert.equal((await h.call("identity",{principal:h.owner.pub})).status,403);
  assert.equal((await h.handler(new Request("https://owner.example/internal/streams/authority",{method:"POST",
    headers:{"Content-Type":"application/json","X-Stream-Service-Key":"c".repeat(32)},body:"x".repeat(4097)}))).status,403);
});


test("parent post revocation denies publishing despite a retained room post grant",async()=>{
  const h=await setup(), principal=await h.subject(h.viewer), scope=h.scope(principal,"publish");
  const grant={owner:h.owner.pub,accessor:h.viewer.pub,from:1700000060,until:1700000660,stated:1,hamState:1700000060};
  for(const object of [h.forum,h.room])h.record("post",{...grant,object});
  assert.equal((await h.call("check",{scope})).status,200);
  h.record("post",{...grant,object:h.forum,stated:0,hamState:1700000061});
  assert.equal((await h.call("check",{scope})).status,403);
  assert.equal((await h.call("check",{scope:h.scope(principal)})).status,200);
});

test("concurrent checks share only a new read and clock rollover rereads",async()=>{
  const h=await setup(), principal=await h.subject(h.viewer), scope=h.scope(principal);
  let rolled=false;
  h.beforeRead(async()=>{await new Promise(resolve=>setTimeout(resolve,10));if(!rolled){h.advance(1);rolled=true;}});
  const before=h.reads();
  const responses=await Promise.all(Array.from({length:22},()=>h.call("check",{scope})));
  assert.ok(responses.every(response=>response.status===200));
  assert.equal(h.reads()-before,2,"one rolled-over read and one fresh cohort read");
  h.record("see",{object:h.room,owner:h.owner.pub,accessor:h.viewer.pub,from:1700000060,until:1700000660,stated:0,hamState:1700000062});
  assert.equal((await h.call("check",{scope})).status,403);
  assert.equal(h.reads()-before,3,"later requests cannot reuse a completed snapshot");
});

test("requests arriving after a snapshot starts require another read",async()=>{
  const h=await setup(), principal=await h.subject(h.viewer), scope=h.scope(principal);
  let started!:()=>void; const entered=new Promise<void>(resolve=>{started=resolve;});
  h.beforeRead(async()=>{started();await new Promise(resolve=>setTimeout(resolve,20));});
  const before=h.reads(), first=h.call("check",{scope});
  await entered;
  const second=h.call("check",{scope});
  assert.deepEqual((await Promise.all([first,second])).map(response=>response.status),[200,200]);
  assert.equal(h.reads()-before,2);
});
