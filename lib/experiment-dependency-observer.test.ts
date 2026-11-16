import test from "node:test";
import assert from "node:assert/strict";
import {createExperimentDependencyObserver, type DependencyMeasurementRow} from "./experiment-dependency-observer";
const action = "12345678-1234-4234-8234-123456789abc";
const binding = {relayOrigin:"https://relay.example",relaySecret:"a".repeat(64),experiment:"landing-message",
 variants:["control","create"],operation:"outbox-read",recordPrefix:"s3rch-outbox-",sampleEvery:1};
const context = () => ({variant:"create",recordName:"s3rch-outbox-"+"b".repeat(64),current:()=>true});
const reply = (status=200,body="record",headers:Record<string,string>={}) => new Response(body,{status,
 headers:{"x-experiment-action":action,etag:'"'+"c".repeat(64)+'"',...headers}});
test("disabled and unsampled observers do not touch the transport or publisher",async()=>{
 const disabled = createExperimentDependencyObserver({get binding(){throw Error("credential read");}});
 assert.equal(await disabled.read(context()),null);
 const observer = createExperimentDependencyObserver({enabled:true,binding:{...binding,sampleEvery:2},
  createAction:()=>"12345678-1234-4234-8234-123456789abd",transport:async()=>{assert.fail();},publish:()=>{assert.fail();}});
 assert.equal(await observer.read(context()),null);
});
test("fixed GET relay attribution preserves response status/body/ETag and emits only independently measured rows",async()=>{
 let rows:readonly DependencyMeasurementRow[]=[];
 const observer = createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,publish:r=>{rows=r;return true;},transport:async(url,init)=>{
  assert.equal(url,"https://relay.example/v1/observe");assert.equal(init?.method,"POST");assert.equal(init.body,"");
  assert.equal(init.redirect,"error");assert.equal(init.credentials,"omit");
  const headers=new Headers(init.headers);assert.equal(headers.get("authorization"),"Bearer "+binding.relaySecret);
  const attribution=JSON.parse(headers.get("x-experiment-attribution")!);
  assert.deepEqual(Object.keys(attribution).sort(),["action","experiment","issued","operation","target","variant"]);
  assert.equal(attribution.action,action);assert.equal(attribution.target,"b".repeat(64));
  return reply(200,"record",{"set-cookie":"private=secret",location:"https://elsewhere.example"});
 }});
 const result=await observer.read(context());assert.ok(result);assert.equal(await result.text(),"record");
 assert.equal(result.headers.get("etag"),'"'+"c".repeat(64)+'"');assert.equal(result.headers.get("set-cookie"),null);assert.equal(result.headers.get("location"),null);
 assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.Metric),["latency_ms","error_rate","dependency_failure_rate"]);
 assert.ok(rows.every(r=>r.ActionId===action && r.Experiment==="landing-message" && r.Variant==="create"));
 assert.equal(rows[1].Value,0);assert.ok(rows[0].Value>=0);assert.equal(Object.isFrozen(rows),true);
 assert.deepEqual(Object.keys(rows[0]).sort(),["ActionId","Experiment","Metric","ObservedAt","Value","Variant"]);
 assert.ok(!JSON.stringify(rows).includes("b".repeat(64)));
});
test("refusals are not server failures and publisher refusal/errors never change the read",async()=>{
 for(const status of [401,403,404,500,503]) {
  let failure:number|undefined;
  const observer=createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,transport:async()=>reply(status),publish:rows=>{failure=rows[1].Value;throw Error("publisher unavailable");}});
  assert.equal((await observer.read(context()))?.status,status);assert.equal(failure,status>=500?1:0);
 }
});
test("unverified or changed native context cannot emit measurements",async()=>{
 let current=true,calls=0;
 const observer=createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,publish:()=>{assert.fail();},transport:async()=>{calls++;current=false;return reply();}});
 await assert.rejects(observer.read({...context(),current:()=>false}));
 await assert.rejects(observer.read({...context(),variant:"invented"}));
 await assert.rejects(observer.read({...context(),recordName:"s3rch-outbox-../private"}));assert.equal(calls,0);
 await assert.rejects(observer.read({...context(),current:()=>current}));assert.equal(calls,1);
});
test("relay rejection without matching action never falls back or creates evidence",async()=>{
 let calls=0;
 const observer=createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,publish:()=>{assert.fail();},transport:async()=>{calls++;return reply(409,"",{"x-experiment-action":"wrong"});}});
 await assert.rejects(observer.read(context()),/^Error: Measured dependency unavailable$/);assert.equal(calls,1);
});
test("acknowledged oversized or redirect replies are failures with bounded cleanup",async()=>{
 for(const redirected of [false,true]) {
  let cancelled=false,failed:number|undefined;
  const observer=createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,publish:rows=>{failed=rows[1].Value;return false;},transport:async()=>redirected ? reply(302) : new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}),{headers:{"x-experiment-action":action}})});
  await assert.rejects(observer.read(context()));assert.equal(failed,1);if(!redirected)assert.equal(cancelled,true);
 }
});
test("deadline bounds the caller and abort-ignoring transports retain bounded slots",async()=>{
 const signals:AbortSignal[]=[];
 const observer=createExperimentDependencyObserver({enabled:true,binding,publish:()=>{assert.fail();},transport:async(_url,init)=>{signals.push(init!.signal!);return new Promise<Response>(()=>{});}});
 const pending=Array.from({length:8},()=>assert.rejects(observer.read(context())));
 assert.equal(await observer.read(context()),null);
 await Promise.all(pending);assert.equal(signals.length,8);assert.ok(signals.every(signal=>signal.aborted));
 assert.equal(await observer.read(context()),null);observer.close();await assert.rejects(observer.read(context()));
});
test("caller abort cancels a stalled body and prevents measurement",async()=>{
 const abort=new AbortController();let cancelled=false;
 const observer=createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,publish:()=>{assert.fail();},transport:async()=>new Response(new ReadableStream({start(){setTimeout(()=>abort.abort(),1);},cancel(){cancelled=true;}}),{headers:{"x-experiment-action":action}})});
 await assert.rejects(observer.read({...context(),signal:abort.signal}));assert.equal(cancelled,true);
});
test("local sampling admission is capped without adding upstream operations",async()=>{
 let calls=0;
 const observer=createExperimentDependencyObserver({enabled:true,binding,publish:()=>false,transport:async(_url,init)=>{
  calls++;const a=JSON.parse(new Headers(init!.headers).get("x-experiment-attribution")!);return reply(200,"",{"x-experiment-action":a.action});
 }});
 for(let i=0;i<60;i++)assert.ok(await observer.read(context()));
 assert.equal(await observer.read(context()),null);assert.equal(calls,60);
});

test("encoded relay replies are refused without reading their body",async()=>{
 let cancelled=false,failed:number|undefined;
 const observer=createExperimentDependencyObserver({enabled:true,binding,createAction:()=>action,publish:rows=>{failed=rows[1].Value;return true;},transport:async(_url,init)=>{
  assert.equal(new Headers(init!.headers).get("accept-encoding"),"identity");
  return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"x-experiment-action":action,"content-encoding":"gzip"}});
 }});
 await assert.rejects(observer.read(context()));assert.equal(cancelled,true);assert.equal(failed,1);
});
