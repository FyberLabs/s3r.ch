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
  S3RCH_EXPERIMENT_PUBLIC_KEY:signing.publicKey.export({type:"spki",format:"pem"}).toString(),IDENTITY_SESSION_SECRET:"private-unit-identity-root-1234567890",
  APPLICATIONINSIGHTS_CONNECTION_STRING:"InstrumentationKey=11111111-1111-4111-8111-111111111111",S3RCH_EXPERIMENT_PRIMARY_V2:"1"};
test("product consumption preserves anonymous assignment through verified SEA sign-in and revokes pending data",async()=>{
  const original=globalThis.fetch, records=new Map<string,{value:string;revision:string}>();let sequence=0;
  const telemetry:Array<{name:string;properties:Record<string,string>}>=[];
  const now=Math.floor(Date.now()/1000);
  const payload=JSON.stringify({version:1,audience:"s3r.ch",sequence:1,issuedAt:now,expiresAt:now+300,
    experiments:[{key:"landing-message",control:"control",variants:["control","create"],weights:[0,1],disabled:false}]});
  globalThis.fetch=async(url,init)=>{
    const target=String(url),headers=new Headers(init?.headers);
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
    assert.equal(target,"https://dc.applicationinsights.azure.com/v2/track");telemetry.push(JSON.parse(String(init?.body)).data.baseData);return new Response(null,{status:200});
  };
  const app=await createExperimentApplication(env),jar=new Map<string,string>();
  const cookie=()=>[...jar].map(([k,v])=>`${k}=${v}`).join("; ");
  async function post(body:unknown,enabled=true){
    const response=await app.post(new Request(site+"/api/experiments",{method:"POST",headers:{origin:site,"content-type":"application/json",cookie:cookie()},body:JSON.stringify(body)}),enabled);
    for(const row of response.headers.getSetCookie()){const pair=row.split(";")[0],at=pair.indexOf("=");if(row.includes("Max-Age=0"))jar.delete(pair.slice(0,at));else jar.set(pair.slice(0,at),pair.slice(at+1));}return response;
  }
  const native=async(subject:string)=>new SignJWT({}).setProtectedHeader({alg:"HS256",typ:"s3rch-identity-session-v1"}).setSubject(subject).setIssuer(site).setAudience(site).setIssuedAt(now).setExpirationTime(now+300).setJti("b".repeat(64)).sign(new TextEncoder().encode(env.IDENTITY_SESSION_SECRET));
  try{
    const ingress={host:"s3r.ch","x-forwarded-proto":"https"};
    assert.equal((await app.get(new Request("http://localhost:3000/api/experiments",{headers:ingress}))).status,200);
    for(const extra of [{host:"attacker.invalid"},{"x-forwarded-host":"attacker.invalid"},{"x-forwarded-proto":"http"}]) {
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
    assert.equal((await post({action:"exposure",display:shown.display,eventId:"12345678-1234-4234-8234-123456789abc"})).status,200);
    assert.equal((await post({action:"conversion",display:shown.display,eventId:"22345678-1234-4234-8234-123456789abc"})).status,400);
    const pair=await createRequire(import.meta.url)("gun/sea").pair();jar.set("__Host-s3rch-squad-session",await native(pair.pub));
    const signed=await (await post({action:"evaluate"})).json();assert.equal(signed.cohort,shown.cohort);assert.equal(signed.authenticated,true);assert.ok(signed.expiresAt<=now+300);
    assert.equal((await post({action:"conversion",display:shown.display,eventId:"22345678-1234-4234-8234-123456789abc"})).status,200);
    assert.equal(telemetry.length,2);assert.equal(telemetry[1].properties.assignment_hash,shown.cohort);assert.equal(telemetry[1].properties.conversion_key,"feed_opened");assert.ok(!JSON.stringify(telemetry).includes(pair.pub));
    jar.set("__Host-s3rch-squad-session",await native("keycloak-account"));assert.equal((await post({action:"evaluate"})).status,401);
    jar.set("__Host-s3rch-squad-session","malformed");assert.equal((await post({action:"evaluate"})).status,401);
    const status=await app.get(new Request(site+"/api/experiments",{headers:{cookie:cookie()}}),false);assert.equal((await status.json()).consented,true);
    assert.equal((await post({action:"consent",allowed:false},false)).status,200);assert.ok(!jar.has("__Host-s3rch-experiment-consent"));
    assert.equal(JSON.parse([...records.values()][0].value).revoked,true);
    jar.delete("__Host-s3rch-squad-session");
    const nearExpiry=createExperimentPrivacy({tenant,origin:site,secret:Buffer.from(env.S3RCH_EXPERIMENT_SECRET,"hex"),clock:()=>now-86390});
    const consent=(await nearExpiry.consent()).split(";")[0];jar.set(consent.slice(0,consent.indexOf("=")),consent.slice(consent.indexOf("=")+1));
    const bounded=await (await post({action:"evaluate"})).json();assert.ok(bounded.expiresAt<=now+10);
  }finally{await app.close();globalThis.fetch=original;}
});
