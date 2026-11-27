import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSeaSessionClient } from "./sea-session-client";
import { createIdentitySessions } from "./sea-session";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const origin = "https://s3r.ch";

test("site client validates endpoint scope before any request", () => {
  for (const options of [{base:"//foreign/session",origin},{base:"https://foreign/session",origin},
    {base:"/session?x=1",origin},{base:"/session",origin:"http://s3r.ch"},{base:"/session",origin:origin+"/"}])
    assert.throws(() => createSeaSessionClient(options));
});

test("site client rejects failed, malformed and oversized challenge responses", async () => {
  const pair = await sea.pair();
  for (const response of [() => new Response(null,{status:503}), () => new Response("plain",{headers:{"content-type":"text/plain"}}),
    () => new Response(null,{headers:{"content-type":"application/json"}}), () => Response.json({}),
    () => Response.json({challenge:3}), () => Response.json({challenge:"x".repeat(4097)}),
    () => Response.json({challenge:"bad-token"}), () => new Response("{",{headers:{"content-type":"application/json"}}),
    () => Response.json({challenge:"x".repeat(9000)})]) {
    let exchanges = 0;
    const client = createSeaSessionClient({base:"/api/identity/sea",origin,fetch:async url => {
      if(String(url).endsWith("exchange")) exchanges++;
      return response();
    }});
    assert.equal(await client.signIn(pair),false); assert.equal(exchanges,0);
  }
  const client = createSeaSessionClient({base:"/api/identity/sea",origin,fetch:async () => { throw Error("offline"); }});
  assert.equal(await client.signIn(pair),false); assert.equal(await client.logout(),false);
});

test("site client serializes sign-in/logout and snapshots the signing key", async () => {
  const pair = await sea.pair(), original = { ...pair }, other = await sea.pair();
  const sessions = createIdentitySessions({origin,secret:"s".repeat(32),consume:async()=>true});
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve=>{release=resolve;}), started = new Promise<void>(resolve=>{entered=resolve;});
  let signedFor: string | null = null;
  const client = createSeaSessionClient({base:"/api/identity/sea/",origin,fetch:async (url,init) => {
    if(String(url).endsWith("challenge")) { entered(); await held; return Response.json({challenge:await sessions.challenge(original.pub)}); }
    const body = JSON.parse(String(init?.body));
    const token = await sessions.exchange(body.challenge,body.signature);
    signedFor = token ? (await sessions.authenticate(token))?.key ?? null : null;
    return Response.json({ok:!!token});
  }});
  const signing = client.signIn(pair); await started;
  assert.equal(await client.signIn(other),false); assert.equal(await client.logout(),false);
  Object.assign(pair,other); release();
  assert.equal(await signing,true); assert.equal(signedFor,original.pub);
});

test("site client refuses an invalid private half", async () => {
  const pair = await sea.pair();
  const client = createSeaSessionClient({base:"/session",origin,fetch:async () => Response.json({challenge:"x"})});
  assert.equal(await client.signIn({...pair,priv:"bad"}),false);
});

test("site client honors cancellation while reading and never exchanges an interrupted proof", async () => {
  const pair = await sea.pair(), abort = new AbortController(); let exchanges = 0;
  const client = createSeaSessionClient({base:"/session",origin,fetch:async url => {
    if(String(url).endsWith("exchange")) exchanges++;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));abort.abort();controller.close();}}),
      {headers:{"content-type":"application/json"}});
  }});
  assert.equal(await client.signIn(pair,abort.signal),false); assert.equal(exchanges,0);
});

test("malformed terminal hints cannot broaden the browser signing intent", async () => {
  const pair = await sea.pair(), sessions = createIdentitySessions({ origin, secret: "s".repeat(32), consume: async () => true });
  const challenge = await sessions.challenge(pair.pub), parts = challenge.split("."), claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  for (const nightly_run of [null, [], "run", {}, { run: "bad run", generation: "a".repeat(64) },
    { run: "valid", generation: "short" }, { run: "valid", generation: "a".repeat(64), extra: true }]) {
    let calls = 0;
    const value = [parts[0], Buffer.from(JSON.stringify({ ...claims, nightly_run })).toString("base64url"), parts[2]].join(".");
    const client = createSeaSessionClient({ base: "/session", origin, fetch: async () => { calls++; return Response.json({ challenge: value }); } });
    assert.equal(await client.signIn(pair), false); assert.equal(calls, 1);
  }
});
