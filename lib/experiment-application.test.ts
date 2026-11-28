import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { SignJWT } from "jose";
import { createExperimentApplication } from "./experiment-application";
import { createExperimentPrivacy } from "./experiment-privacy";
const signing=generateKeyPairSync("ed25519"), site="https://s3r.ch", tenant="12345678-1234-4234-8234-123456789abc";
const env={S3RCH_EXPERIMENT_ORIGIN:site,S3RCH_EXPERIMENT_TENANT:tenant,S3RCH_EXPERIMENT_SECRET:"a".repeat(64),
  S3RCH_EXPERIMENT_STORAGE_ORIGIN:"https://storage.example.test",S3RCH_EXPERIMENT_CACHE_KEY:"cache-key-1234567890",S3RCH_EXPERIMENT_OUTBOX_KEY:"outbox-key-1234567890",
  S3RCH_EXPERIMENT_PUBLIC_KEY:signing.publicKey.export({type:"spki",format:"pem"}).toString(),S3RCH_SESSION_SIGNING_KEY:"private-unit-identity-root-1234567890",
  APPLICATIONINSIGHTS_CONNECTION_STRING:"InstrumentationKey=11111111-1111-4111-8111-111111111111",S3RCH_EXPERIMENT_PRIMARY_V2:"1"};
for(const mode of ["disabled","active","withdrawn","invalid","failed"]) test(`native product operation with measurements ${mode}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"s3rch-measurement-"));
  const appEnv:Record<string,string>={...env};let observations=0,uploads=0,retention=0;
  const rows:Array<Record<string,unknown>>=[];
  if(mode!=="disabled") {
    await writeFile(join(dir,"relay"),"b".repeat(64),{mode:0o600});await writeFile(join(dir,"ingest"),"private-ingestion-credential",{mode:0o600});
    Object.assign(appEnv,{S3RCH_MEASUREMENTS_ENABLED:"1",S3RCH_MEASUREMENTS_TENANT:tenant,
      S3RCH_MEASUREMENTS_SECRET_FILE:join(dir,"ingest"),S3RCH_MEASUREMENTS_RELAY_SECRET_FILE:join(dir,"relay"),
      S3RCH_MEASUREMENTS_INGESTION_ENDPOINT:"https://test.ingest.monitor.azure.com",S3RCH_MEASUREMENTS_DCR_ID:"dcr-"+"c".repeat(32),
      S3RCH_MEASUREMENTS_DIRECTORY:tenant,S3RCH_MEASUREMENTS_CLIENT_ID:"22345678-1234-4234-8234-123456789abc",
      S3RCH_MEASUREMENTS_RELAY_ORIGIN:"https://measurements.example.test",S3RCH_MEASUREMENTS_SAMPLE_EVERY:"1"});
  }
  const original=globalThis.fetch, records=new Map<string,{value:string;revision:string}>();let sequence=0;
  const telemetry:Array<{name:string;properties:Record<string,string>}>=[];
  const now=Math.floor(Date.now()/1000);
  const payload=JSON.stringify({version:1,audience:"s3r.ch",sequence:1,issuedAt:now,expiresAt:now+300,
    experiments:[{key:"landing-message",control:"control",variants:["control","create"],weights:[0,1],disabled:false}]});
  globalThis.fetch=async(url,init)=>{
    const target=String(url),headers=new Headers(init?.headers);
    if(target==="https://measurements.example.test/v1/observe") {
      observations++;assert.notEqual(mode,"disabled");assert.equal(headers.get("authorization"),"Bearer "+"b".repeat(64));assert.equal(headers.has("x-api-key"),false);
      const a=JSON.parse(headers.get("x-experiment-attribution")!);
      assert.deepEqual(Object.keys(a).sort(),["action","experiment","issued","operation","target","variant"]);
      assert.equal(a.experiment,"landing-message");assert.equal(a.variant,"create");assert.equal(a.operation,"s3rch-outbox-read");assert.match(a.target,/^[a-f0-9]{64}$/);
      assert.notEqual(a.action,"12345678-1234-4234-8234-123456789abc");
      const found=mode==="withdrawn"?{value:JSON.stringify({version:1,expires:retention,revoked:true,rows:[]}),revision:"b".repeat(64)}:
        mode==="invalid"?{value:"invalid-json",revision:"b".repeat(64)}:records.get("https://storage.example.test/api/v1/storage/records/experiments/s3rch-outbox-"+a.target);
      return new Response(found?.value??null,{status:mode==="failed"?503:found?200:404,headers:{"x-experiment-action":a.action,...(found?{etag:`"${found.revision}"`}:{})}});
    }
    if(target.startsWith("https://login.microsoftonline.com/"))return Response.json({access_token:"private-server-token",token_type:"Bearer",expires_in:3600});
    if(target.startsWith("https://test.ingest.monitor.azure.com/")) {
      uploads++;assert.equal(headers.get("authorization"),"Bearer private-server-token");
      const batch=JSON.parse(String(init?.body));for(const row of batch)assert.deepEqual(Object.keys(row).sort(),["ActionId","Experiment","Metric","ObservedAt","Value","Variant"]);rows.push(...batch);
      return new Response(null,{status:204});
    }
    if(target.endsWith("experiments/s3rch-cache")){
      assert.equal(headers.get("x-api-key"),env.S3RCH_EXPERIMENT_CACHE_KEY);
      return Response.json({payload,signature:sign(null,Buffer.from(payload),signing.privateKey).toString("base64url")});
    }
    if(target.startsWith("https://storage.example.test/api/v1/storage/records/experiments/")){
      assert.equal(headers.get("x-api-key"),env.S3RCH_EXPERIMENT_OUTBOX_KEY);assert.equal(headers.get("x-tenant-id"),tenant);
      const found=records.get(target);
      if(init?.method==="GET")return new Response(found?.value??null,{status:found?200:404,headers:found?{etag:`"${found.revision}"`}:{}});
      if(found?headers.get("if-match")!==`"${found.revision}"`:headers.get("if-none-match")!=="*")return new Response(null,{status:412});
      records.set(target,{value:String(init?.body),revision:(++sequence).toString(16).padStart(64,"0")});return new Response(null,{status:found?204:201});
    }
    assert.equal(target,"https://dc.applicationinsights.azure.com/v2/track");telemetry.push(JSON.parse(String(init?.body)).data.baseData);return Response.json({itemsReceived:1,itemsAccepted:1,errors:[]});
  };
  const app=await createExperimentApplication(appEnv),jar=new Map<string,string>();
  const cookie=()=>[...jar].map(([k,v])=>`${k}=${v}`).join("; ");
  async function post(body:unknown,enabled=true){
    const response=await app.post(new Request(site+"/api/experiments",{method:"POST",headers:{origin:site,"content-type":"application/json",cookie:cookie()},body:JSON.stringify(body)}),enabled);
    for(const row of response.headers.getSetCookie()){const pair=row.split(";")[0],at=pair.indexOf("=");if(row.includes("Max-Age=0"))jar.delete(pair.slice(0,at));else jar.set(pair.slice(0,at),pair.slice(at+1));}return response;
  }
  const native=async(subject:string)=>new SignJWT({}).setProtectedHeader({alg:"HS256",typ:"s3rch-identity-session-v1"}).setSubject(subject).setIssuer(site).setAudience(site).setIssuedAt(now).setExpirationTime(now+300).setJti("b".repeat(64)).sign(new TextEncoder().encode(env.S3RCH_SESSION_SIGNING_KEY));
  try{
    const ingress={host:"s3r.ch","x-forwarded-proto":"https"};
    assert.equal((await app.get(new Request("http://localhost:3000/api/experiments",{headers:ingress}))).status,200);
    const refusedHeaders:Record<string,string>[]=[{host:"attacker.invalid"},{"x-forwarded-host":"attacker.invalid"},{"x-forwarded-proto":"http"}];
    for(const extra of refusedHeaders) {
      assert.equal((await app.get(new Request("http://localhost:3000/api/experiments",{headers:{...ingress,...extra}}))).status,403);
    }
    const write=()=>new Request("http://localhost:3000/api/experiments",{method:"POST",headers:{...ingress,origin:site,"content-type":"application/json"},body:JSON.stringify({action:"evaluate"})});
    assert.equal((await app.post(write())).status,200);
    assert.equal((await app.post(new Request(write(),{headers:{...ingress,origin:"https://attacker.invalid","content-type":"application/json"}}))).status,403);
    assert.equal((await post({action:"evaluate",subject:"injected"})).status,400);
    assert.equal((await post({action:"error",failures:10000})).status,400);
    assert.equal((await post({action:"consent",allowed:true})).status,200);
    const [first,other]=await Promise.all([post({action:"evaluate"}),post({action:"evaluate"})]);
    const shown=await first.json();assert.equal(shown.variant,"create");assert.equal((await other.json()).cohort,shown.cohort);
    assert.equal(observations,0,"evaluate/cache/initial consent reads are not measured");
    assert.equal((await post({action:"exposure",display:"forged",eventId:"12345678-1234-4234-8234-123456789abc"})).status,400);assert.equal(observations,0);
    const privacy=createExperimentPrivacy({tenant,origin:site,secret:Buffer.from(env.S3RCH_EXPERIMENT_SECRET,"hex")});retention=(await privacy.privacy(cookie()))!.retentionUntil;
    const exposed=await post({action:"exposure",display:shown.display,eventId:"12345678-1234-4234-8234-123456789abc"});
    await new Promise(resolve=>setImmediate(resolve));
    if(["withdrawn","invalid","failed"].includes(mode)) {
      assert.equal(exposed.status,503);assert.ok(observations>0);assert.equal(telemetry.length,0);
      if(mode==="failed"){assert.ok(uploads>0);assert.ok(rows.some(row=>row.Metric==="dependency_failure_rate"&&row.Value===1));}
      else assert.equal(uploads,0,"revoked or invalid ledger discards staged observations");return;
    }
    assert.equal(exposed.status,200);
    assert.equal(observations>0,mode==="active");assert.equal(uploads>0,mode==="active");
    assert.equal((await post({action:"conversion",display:shown.display,eventId:"22345678-1234-4234-8234-123456789abc"})).status,400);
    const pair=await createRequire(import.meta.url)("gun/sea").pair();jar.set("__Host-s3rch-squad-session",await native(pair.pub));
    const signed=await (await post({action:"evaluate"})).json();assert.equal(signed.cohort,shown.cohort);assert.equal(signed.authenticated,true);assert.ok(signed.expiresAt<=now+300);
    assert.equal((await post({action:"conversion",display:shown.display,eventId:"22345678-1234-4234-8234-123456789abc"})).status,200);
    assert.equal(telemetry.length,2);assert.equal(telemetry[1].properties.assignment_hash,shown.cohort);assert.equal(telemetry[1].properties.conversion_key,"feed_opened");assert.ok(!JSON.stringify(telemetry).includes(pair.pub));
    jar.set("__Host-s3rch-squad-session",await native("keycloak-account"));assert.equal((await post({action:"evaluate"})).status,401);
    jar.set("__Host-s3rch-squad-session","malformed");assert.equal((await post({action:"evaluate"})).status,401);
    const status=await app.get(new Request(site+"/api/experiments",{headers:{cookie:cookie()}}),false);assert.equal((await status.json()).consented,true);
    const withdrawn=await post({action:"consent",allowed:false},false);
    assert.equal(withdrawn.status,200);assert.deepEqual(await withdrawn.json(),{consented:false,withdrawalVerified:true});assert.ok(!jar.has("__Host-s3rch-experiment-consent"));
    assert.equal(JSON.parse([...records.values()][0].value).revoked,true);
    jar.delete("__Host-s3rch-squad-session");
    assert.deepEqual(await (await post({action:"consent",allowed:false},false)).json(),{consented:false,withdrawalVerified:true});
    jar.set("__Host-s3rch-experiment-consent","malformed");
    assert.deepEqual(await (await post({action:"consent",allowed:false},false)).json(),{consented:false,withdrawalVerified:false});
    for (const secret of [env.S3RCH_EXPERIMENT_SECRET,"f".repeat(64)]) {
      const privacy=createExperimentPrivacy({tenant,origin:site,secret:Buffer.from(secret,"hex"),clock:()=>now-86500});
      const saved=(await privacy.consent()).split(";")[0];jar.set("__Host-s3rch-experiment-consent",saved.slice(saved.indexOf("=")+1));
      assert.deepEqual(await (await post({action:"consent",allowed:false},false)).json(),{consented:false,withdrawalVerified:secret===env.S3RCH_EXPERIMENT_SECRET});
    }
    const duplicate=await app.post(new Request(site+"/api/experiments",{method:"POST",headers:{origin:site,"content-type":"application/json",cookie:"__Host-s3rch-experiment-consent=a; __Host-s3rch-experiment-consent=b"},body:JSON.stringify({action:"consent",allowed:false})}),false);
    assert.deepEqual(await duplicate.json(),{consented:false,withdrawalVerified:false});
    const nearExpiry=createExperimentPrivacy({tenant,origin:site,secret:Buffer.from(env.S3RCH_EXPERIMENT_SECRET,"hex"),clock:()=>now-86390});
    const consent=(await nearExpiry.consent()).split(";")[0];jar.set(consent.slice(0,consent.indexOf("=")),consent.slice(consent.indexOf("=")+1));
    const bounded=await (await post({action:"evaluate"})).json();assert.ok(bounded.expiresAt<=now+10);
  }finally{await app.close();globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
