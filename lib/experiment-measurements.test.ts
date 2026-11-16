import test from "node:test";
import assert from "node:assert/strict";
import { createS3rchMeasurements, measurementScope } from "./experiment-measurements";

test("disabled configuration never reads credentials and explicit foreign tenant refuses", async () => {
  assert.equal(await createS3rchMeasurements({ S3RCH_MEASUREMENTS_SECRET_FILE: "/nonexistent" }), undefined);
  await assert.rejects(createS3rchMeasurements({ S3RCH_MEASUREMENTS_ENABLED: "1", S3RCH_EXPERIMENT_TENANT: "one", S3RCH_MEASUREMENTS_TENANT: "two" }), /tenant/);
});

test("concurrent native measurement scopes remain isolated and disappear after work", async () => {
  const variants: string[] = [];
  const scope = measurementScope({ async read(input) { variants.push(input.variant); assert.equal(input.current(), true); return null; }, close() {} });
  const signal = new AbortController().signal;
  assert.equal(await scope.read("unverified", signal), null);
  await Promise.all(["control", "create"].map(variant => scope.run({experiment:"landing-message",variant,current:()=>true}, async () => {
    await new Promise(resolve => setImmediate(resolve)); await scope.read("record", signal);
  })));
  assert.deepEqual(variants.sort(), ["control", "create"]);
  assert.equal(await scope.read("unverified", signal), null);
  await assert.rejects(scope.run({experiment:"landing-message",variant:"browser-injected",current:()=>true}, async () => {}));
});


test("a returned revoked ledger discards scoped rows while genuine failures retain initial consent", async () => {
  const { createExperimentOutbox } = await import("./experiment-outbox");
  const { randomUUID } = await import("node:crypto");
  let published = 0;
  const scope = measurementScope({ async read() { return null; }, close() {} }, () => { published++; return true; });
  const row = { ActionId: randomUUID(), Experiment: "landing-message", Variant: "create", Metric: "error_rate" as const, ObservedAt: Math.floor(Date.now()/1000), Value: 1 };
  const expires = Date.now()+10000;
  const queue = createExperimentOutbox({ consentId: "b".repeat(64), retentionUntil: expires,
    measurementValidity: scope.accepted, permitted: () => true,
    sinks: { primary: { supportedEventTypes: ["experiment.exposure.v1"], async send() {} } },
    store: { async read() { scope.stage([row]); return { value: JSON.stringify({version:1, expires, revoked:true, rows:[]}), revision:"a".repeat(64) }; }, async write() { throw Error("Must not write"); } },
  });
  await scope.run({experiment:"landing-message",variant:"create",current:()=>true}, async () => { assert.equal(await queue.active(), false); });
  assert.equal(published, 0);
  await assert.rejects(scope.run({experiment:"landing-message",variant:"create",current:()=>true}, async () => { scope.stage([row]); throw Error("Actual dependency failed before returning a ledger"); }));
  assert.equal(published, 1);
});

test("all still-trusted previous signing keys remain separate from measurement credentials", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "measurement-rotation-"));
  try {
    await writeFile(join(dir,"relay"),"b".repeat(64),{mode:0o600});
    await writeFile(join(dir,"azure"),"private-server-ingestion-key",{mode:0o600});
    await assert.rejects(createS3rchMeasurements({S3RCH_MEASUREMENTS_ENABLED:"1",
      S3RCH_EXPERIMENT_TENANT:"12345678-1234-4234-8234-123456789abc",S3RCH_MEASUREMENTS_TENANT:"12345678-1234-4234-8234-123456789abc",
      S3RCH_EXPERIMENT_PREVIOUS_SECRETS:"b".repeat(64),S3RCH_MEASUREMENTS_RELAY_SECRET_FILE:join(dir,"relay"),S3RCH_MEASUREMENTS_SECRET_FILE:join(dir,"azure")}),/Separate measurement credentials/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});


test("native cancellation and expired context suppress staged rows",async()=>{
 let valid=true,published=0;const abort=new AbortController();
 const scope=measurementScope({async read(input){assert.equal(input.signal,abort.signal);return null;},close(){}},()=>{published++;return true;});
 await scope.run({experiment:"landing-message",variant:"create",signal:abort.signal,current:()=>valid&&!abort.signal.aborted},async()=>{
  await scope.read("native-record");scope.stage([]);abort.abort();valid=false;
 });
 assert.equal(published,0);
});
