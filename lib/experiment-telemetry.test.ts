import test from "node:test";
import assert from "node:assert/strict";
import { createExperimentTelemetry, createManualExperimentClient, validExperimentConnection, emitExperimentEvent } from "./experiment-telemetry";
import { context, ROOT_CONTEXT, trace, type Context, type ContextManager } from "@opentelemetry/api";
const key = "11111111-1111-4111-8111-111111111111";
const connection = `InstrumentationKey=${key};IngestionEndpoint=https://eastus-0.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=${key}`;
const payload = { experiment_key: "layout", variant: "control", assignment_hash: "a".repeat(64), surface: "s3r.ch" };

test("only the configured first-party Azure connection is accepted", () => {
  assert.equal(validExperimentConnection(connection), true);
  assert.equal(validExperimentConnection(`InstrumentationKey=${key}`), true);
  for (const value of [undefined, "", "x".repeat(4097), "InstrumentationKey=private", connection + "\n", connection + ";Secret=private", "InstrumentationKey=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    connection + `;instrumentationkey=${key}`, connection.replace(`ApplicationId=${key}`, "ApplicationId=bad"),
    ...["http://eastus.in.applicationinsights.azure.com/", "https://other.invalid/", "https://user@eastus.in.applicationinsights.azure.com/",
      "https://eastus.in.applicationinsights.azure.com/?private=x", "https://eastus.in.applicationinsights.azure.com/path", "not-a-url"]
      .map(endpoint => `InstrumentationKey=${key};IngestionEndpoint=${endpoint}`)]) assert.equal(validExperimentConnection(value), false);
});

test("invalid events and absent configuration never initialize or call the transport", async () => {
  let calls = 0;
  const factory = async () => { calls++; return { trackEvent() { calls++; }, async flush() {} }; };
  const absent = createExperimentTelemetry(undefined, factory);
  assert.equal(await absent.emit("experiment.exposure.v1", payload), false);
  assert.equal(await absent.flush(), false);
  const configured = createExperimentTelemetry(connection, factory);
  assert.equal(await configured.emit("experiment.exposure.v1", { ...payload, email: "private" }), false);
  assert.equal(calls, 0);
});

test("concurrent emissions share one client and contain only the validated first-party schema", async () => {
  let initialized = 0, flushed = 0; const events: unknown[] = [];
  const telemetry = createExperimentTelemetry(connection, async value => {
    assert.equal(value, connection); initialized++;
    return { trackEvent(event) { events.push(event); }, async flush() { flushed++; } };
  });
  assert.deepEqual(await Promise.all([telemetry.emit("experiment.exposure.v1", payload), telemetry.emit("experiment.conversion.v1", payload)]), [true, true]);
  assert.equal(initialized, 1);
  assert.deepEqual(events, [{ name: "experiment.exposure.v1", properties: payload }, { name: "experiment.conversion.v1", properties: payload }]);
  assert.equal(await telemetry.flush(), true); assert.equal(flushed, 1);
});

test("client creation, queueing and flush failures are isolated from the request", async () => {
  for (const phase of ["create", "track", "flush"]) {
    const telemetry = createExperimentTelemetry(connection, async () => {
      if (phase === "create") throw Error("private");
      return { trackEvent() { if (phase === "track") throw Error("private"); }, async flush() { throw Error("private"); } };
    });
    assert.equal(await telemetry.emit("experiment.exposure.v1", payload), phase === "flush");
    assert.equal(await telemetry.flush(), false);
  }
});


test("explicit ingestion contains only the event envelope and has bounded transport", async () => {
  await assert.rejects(() => createManualExperimentClient("private"));
  let sent = 0;
  const client = await createManualExperimentClient(connection, async (url, init) => {
    sent++;
    assert.equal(url, "https://eastus-0.in.applicationinsights.azure.com/v2/track");
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { "content-type": "application/json" });
    const envelope = JSON.parse(String(init.body));
    assert.match(envelope.time, /^\d{4}-/); delete envelope.time;
    assert.deepEqual(envelope, { ver: 1, name: "Microsoft.ApplicationInsights.Event", sampleRate: 100, iKey: key,
      tags: { "ai.cloud.role": "s3rch" }, data: { baseType: "EventData", baseData: { ver: 2, name: "experiment.exposure.v1", properties: payload } } });
    return new Response(null, { status: 200 });
  });
  assert.equal(sent, 0);
  await client.trackEvent({ name: "experiment.exposure.v1", properties: payload as any });
  await client.flush(); assert.equal(sent, 1);
});

test("ingestion errors and partial acceptance fail without retry or unbounded concurrency", async () => {
  for (const status of [206, 400, 429, 500]) {
    const client = await createManualExperimentClient(`InstrumentationKey=${key}`, async () => new Response(null, { status }));
    await assert.rejects(client.trackEvent({ name: "experiment.exposure.v1", properties: payload as any }));
  }
  const releases: (() => void)[] = [];
  const client = await createManualExperimentClient(connection, async () => {
    await new Promise<void>(resolve => releases.push(resolve)); return new Response(null, { status: 200 });
  });
  const pending = Array.from({ length: 8 }, () => client.trackEvent({ name: "experiment.exposure.v1", properties: payload as any }));
  await assert.rejects(client.trackEvent({ name: "experiment.exposure.v1", properties: payload as any }));
  releases.forEach(release => release()); await Promise.all(pending);
});

test("request span identifiers are absent during event tracking", async () => {
  let active = ROOT_CONTEXT;
  const manager: ContextManager = {
    active: () => active,
    with(ctx: Context, fn: (...args: any[]) => any, thisArg?: any, ...args: any[]) {
      const previous = active; active = ctx;
      try { return fn.call(thisArg, ...args); } finally { active = previous; }
    },
    bind: (_ctx, target) => target, enable() { return this; }, disable() { return this; },
  };
  context.setGlobalContextManager(manager);
  try {
    active = trace.setSpanContext(ROOT_CONTEXT, { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 });
    const telemetry = createExperimentTelemetry(connection, async () => ({
      trackEvent() { assert.equal(trace.getSpanContext(context.active()), undefined); }, async flush() {},
    }));
    assert.equal(await telemetry.emit("experiment.exposure.v1", payload), true);
    assert.equal(trace.getSpanContext(context.active())?.traceId, "a".repeat(32));
  } finally { context.disable(); }
});


test("process adapter stays lazy and isolates missing configuration", async () => {
  const previous = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  try { assert.equal(await emitExperimentEvent("experiment.exposure.v1", payload), false); }
  finally {
    if (previous === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = previous;
  }
});

test("named telemetry carries the caller's stable ID on both attempts without private context", async () => {
  const sent: Array<Record<string, any>> = [];
  const telemetry = createExperimentTelemetry(connection, async value => createManualExperimentClient(value, async (_url, init) => {
    sent.push(JSON.parse(init.body as string));
    return new Response(null, { status: 200 });
  }), { supportedEventTypes: ["experiment.conversion.v2"], metrics: { layout: ["sign_in_completed"] } });
  const named = { ...payload, conversion_key: "sign_in_completed" };
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(await telemetry.emit("experiment.conversion.v2", named, key), true);
  assert.equal(sent.length, 2);
  for (const event of sent) {
    assert.deepEqual(event.data.baseData.properties, { ...named, event_id: key });
    assert.deepEqual(event.tags, { "ai.cloud.role": "s3rch" });
  }
});
