import test from "node:test";
import assert from "node:assert/strict";
import { parseCrashReport } from "./crash-report";
import { ingestCrash } from "./crash-ingestion";
import { createErrorRecorder, releaseContext } from "./release-telemetry-server";
import { createBrowserReporter } from "./browser-crash-report";
const report = {kind:"browser-error",version:"0.1.18",color:"blue",upstreamVersion:"0.24.0",upstreamColor:"green"};
const req = (value:unknown,origin="https://s3r.ch") => new Request("https://s3r.ch/api/telemetry/error",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(value)});

test("crash schema rejects private fields and arbitrary labels", () => {
  assert.deepEqual(parseCrashReport(report),report);
  for (const key of ["message","stack","email","wallet","subject","cookie","url","ip","userAgent","prompt","age"])
    assert.equal(parseCrashReport({...report,[key]:"private"}),null);
  for (const [key,value] of [["kind","private"],["version","person@example.org"],["color","person"],["upstreamVersion","private"],["upstreamColor","private"]])
    assert.equal(parseCrashReport({...report,[key]:value}),null);
  for (const v of [null,[],{},"private"]) assert.equal(parseCrashReport(v),null);
  assert.equal(releaseContext({S3RCH_RELEASE_COLOR:"private"}).color,null);
});
test("first-party ingestion bounds input and rejects cross-origin reports", async () => {
  let calls=0;const sink=()=>{calls++;return true;};
  assert.equal((await ingestCrash(req(report),sink)).status,204);
  assert.equal((await ingestCrash(req(report,"https://other.example"),sink)).status,403);
  assert.equal((await ingestCrash(req({...report,message:"private"}),sink)).status,400);
  assert.equal((await ingestCrash(req("x".repeat(1025)),sink)).status,400);
  assert.equal((await ingestCrash(new Request("https://s3r.ch/api/telemetry/error",{method:"POST"}),sink)).status,403);
  assert.equal(calls,1);
  assert.equal((await ingestCrash(req(report),()=>false)).status,429);
});
test("error records carry deployment tags and throttle without identifiers", () => {
  let time=0;const lines:string[]=[];const emit=createErrorRecorder(line=>lines.push(line),()=>time);
  for(let i=0;i<120;i++) assert.equal(emit("server-error"),true);
  assert.equal(emit("server-error"),false);assert.equal(emit("browser-crash",parseCrashReport(report)!),true);time=60_000;assert.equal(emit("server-error"),true);
  const event=JSON.parse(lines[0]);assert.equal(event.event,"s3rch.error.v1");assert.equal(event.severity,"Error");
  assert.match(event.release.version,/^\d+\.\d+\.\d+$/);assert.deepEqual(Object.keys(event).sort(),["event","kind","release","severity"]);
  assert.equal(createErrorRecorder(()=>{throw Error("private");})("server-error"),false);
});
test("browser reporter sends only allowed fields and swallows transport errors", async () => {
  const sent:unknown[]=[];
  const fetcher=(async (url:string,init?:RequestInit)=>{
    if(url.endsWith("context"))return Response.json({color:"green",upstreamColor:"blue",upstreamVersion:"0.24.0",email:"private"});
    assert.equal(init?.credentials,"omit");sent.push(JSON.parse(String(init?.body)));throw Error("private");
  }) as typeof fetch;
  const emit=createBrowserReporter(fetcher);for(let i=0;i<25;i++)emit("browser-error");
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sent.length,20);
  for(const row of sent){assert.ok(parseCrashReport(row));assert.equal(JSON.stringify(row).includes("private"),false);}
});

test("malformed, empty and stalled request bodies fail without logging", async () => {
  const sink=()=>{assert.fail("invalid input must not reach logs");};
  const request=(body:BodyInit|null)=>new Request("https://s3r.ch/api/telemetry/error",{method:"POST",headers:{Origin:"https://s3r.ch","Content-Type":"application/json"},body,...(body instanceof ReadableStream ? {duplex:"half"} : {})} as RequestInit);
  for(const body of [null,"{",new Uint8Array([255])])assert.equal((await ingestCrash(request(body),sink)).status,400);
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  assert.equal((await ingestCrash(request(body),sink)).status,400);assert.equal(cancelled,true);
});
test("unavailable browser context still emits a minimal bounded report", async () => {
  const sent:unknown[]=[];
  const emit=createBrowserReporter((async(url:string,init?:RequestInit)=>{
    if(url.endsWith("context"))throw Error("private");
    sent.push(JSON.parse(String(init?.body)));return new Response(null,{status:204});
  }) as typeof fetch);
  emit("render-error");await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(sent.length,1);assert.equal((sent[0] as {color:null}).color,null);assert.ok(parseCrashReport(sent[0]));
});
