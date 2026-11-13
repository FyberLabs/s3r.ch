import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { siteSeaSession } from "./site-sea-session-server";
import { createSeaSessionClient } from "./sea-session-client";
import { readSeaRequestSession } from "./sea-request-session";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const env = { IDENTITY_SESSION_SECRET: "s".repeat(32), S3RCH_IDENTITY_REPLAY_BACKEND: "spanopticon",
  S3RCH_IDENTITY_REPLAY_ORIGIN: "https://storage.example", S3RCH_IDENTITY_REPLAY_TENANT_ID: "afee9b29-1706-5590-bbbf-e58df8945ac0",
  S3RCH_IDENTITY_REPLAY_API_KEY: "dedicated-key" };
const origin = "https://s3r.ch";

test("site client establishes the existing SEA session without a Squad or Blob configuration", async () => {
  const pair = await sea.pair(), cookies = new Map<string, string>(), used = new Set<string>();
  let calls = 0, now = 1700000000;
  const cookie = () => [...cookies].map(([k,v]) => k+"="+v).join("; ");
  const storage: typeof fetch = async (url, init) => {
    calls++; assert.ok(String(url).startsWith("https://storage.example/api/v1/storage/replays/"));
    assert.equal(init?.method, "POST");
    const key = String(url); const reused = used.has(key); used.add(key);
    return new Response(null, { status: reused ? 409 : 204 });
  };
  const request: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers); headers.set("origin", origin); headers.set("cookie", cookie());
    const action = String(url).split("/").at(-1)!;
    const response = await siteSeaSession(new Request(origin+url, { ...init, headers }), action, env, storage, () => now);
    for (const row of response.headers.getSetCookie()) {
      const [key,value] = row.split(";")[0].split("="); if (value) cookies.set(key,value); else cookies.delete(key);
    }
    return response;
  };
  const client = createSeaSessionClient({ base: "/api/identity/sea", origin, fetch: request, clock: () => now });
  assert.equal(await client.signIn(pair), true); assert.equal(calls, 1);
  const status = await request("/api/identity/sea/session");
  assert.deepEqual(await status.json(), { enabled: true, principal: pair.pub, expiresAt: (now+300)*1000 });
  assert.equal(status.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await readSeaRequestSession(new Request(origin, { headers: { cookie: cookie() } }), env, () => now), { key: pair.pub });
  now += 300;
  assert.deepEqual(await (await request("/api/identity/sea/session")).json(), { enabled: true, principal: null, expiresAt: null });
  assert.equal(await client.signIn(pair), true);
  assert.equal(await client.logout(), true); assert.equal(cookies.size, 0);
});

test("site identity is disabled without remote replay and rejects partial configuration without IO", async () => {
  const noIO: typeof fetch = async () => { assert.fail("no provider call"); };
  const get = new Request(origin+"/api/identity/sea/session");
  assert.deepEqual(await (await siteSeaSession(get,"session",{},noIO)).json(), { enabled:false, principal:null });
  const post = new Request(origin+"/api/identity/sea/challenge", { method:"POST", headers:{origin,"content-type":"application/json"}, body:"{}" });
  assert.equal((await siteSeaSession(post,"challenge",{},noIO)).status,503);
  assert.equal((await siteSeaSession(get,"session",{S3RCH_IDENTITY_REPLAY_BACKEND:"spanopticon"},noIO)).status,503);
  assert.equal((await siteSeaSession(get,"session",{...env,IDENTITY_SESSION_SECRET:undefined},noIO)).status,503);
  assert.equal((await siteSeaSession(get,"unknown",env,noIO)).status,404);
  assert.equal((await siteSeaSession(get,"challenge",env,noIO)).status,404);
});

test("foreign origins, insecure requests, linked metadata and legacy wallet cookies cannot authenticate", async () => {
  const noIO: typeof fetch = async () => { assert.fail("no provider call"); };
  for (const url of ["http://s3r.ch", "https://foreign.invalid", "https://s3r.ch:8443"])
    assert.equal((await siteSeaSession(new Request(url),"session",env,noIO)).status,403);
  for (const cookie of ["s3rch-session=legacy", "__Host-s3rch-startup-credential=linked", "__Host-s3rch-squad-session=bad"])
    assert.deepEqual(await (await siteSeaSession(new Request(origin,{headers:{cookie}}),"session",env,noIO)).json(),
      {enabled:true,principal:null,expiresAt:null});
  const foreign = new Request(origin+"/api/identity/sea/challenge", {method:"POST",headers:{origin:"https://foreign.invalid","content-type":"application/json"},body:"{}"});
  assert.equal((await siteSeaSession(foreign,"challenge",env,noIO)).status,403);
});

// CI-only signed HTTP compatibility: old Squad and new site paths share one issuer.
test("cached Squad clients use the shared issuer and replay store through the alias", async t => {
  const {POST} = await import("../../app/api/squad/pilot/[...path]/route");
  const values={...env,S3RCH_SQUAD_PILOT:"old-pilot-config-is-not-an-issuer"};
  const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  const cookies=new Map<string,string>(), used=new Set<string>(); let consumes=0;
  t.mock.method(globalThis,"fetch",async (url: string | URL | Request, init?: RequestInit)=>{
    assert.ok(String(url).startsWith("https://storage.example/api/v1/storage/replays/"));
    assert.equal(init?.method,"POST"); consumes++;
    const repeated=used.has(String(url));used.add(String(url));return new Response(null,{status:repeated?409:204});
  });
  const request:typeof fetch=async(url,init)=>{
    const headers=new Headers(init?.headers);headers.set("origin",origin);
    headers.set("cookie",[...cookies].map(([key,value])=>key+"="+value).join("; "));
    const path=String(url),action=path.split("/").at(-1)!;
    const req=new Request(origin+path,{...init,headers});
    const response=path.startsWith("/api/squad/")
      ? await POST(req,{params:Promise.resolve({path:["session",action]})})
      : await siteSeaSession(req,action);
    for(const row of response.headers.getSetCookie()) {
      const [key,value]=row.split(";")[0].split("=");if(value)cookies.set(key,value);else cookies.delete(key);
    }
    return response;
  };
  try {
    Object.assign(process.env,values);
    const pair=await sea.pair();
    const old=createSeaSessionClient({base:"/api/squad/pilot/session",origin,fetch:request});
    const current=createSeaSessionClient({base:"/api/identity/sea",origin,fetch:request});
    assert.equal(await old.signIn(pair),true); assert.equal(consumes,1);
    assert.equal((await (await request("/api/identity/sea/session")).json()).principal,pair.pub);
    assert.equal(await current.logout(),true);assert.equal(cookies.size,0);
    assert.equal(await current.signIn(pair),true);assert.equal(consumes,2);
    assert.equal(await old.logout(),true);assert.equal(cookies.size,0);
  } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
