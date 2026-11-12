import test from "node:test";
import assert from "node:assert/strict";
import { createExperimentTelemetry, createManualExperimentClient, validExperimentConnection } from "./experiment-telemetry";
const key = "11111111-1111-4111-8111-111111111111";
const connection = `InstrumentationKey=${key};IngestionEndpoint=https://eastus-0.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=${key}`;
const payload = { experiment_key: "layout", variant: "control", assignment_hash: "a".repeat(64), surface: "s3r.ch" };

test("only the configured first-party Azure connection is accepted", () => {
  assert.equal(validExperimentConnection(connection), true);
  assert.equal(validExperimentConnection(`InstrumentationKey=${key}`), true);
  for (const value of [undefined, "", "x".repeat(4097), "InstrumentationKey=private", connection + "\n", connection + ";Secret=private",
    connection + `;instrumentationkey=${key}`, connection.replace(`ApplicationId=${key}`, "ApplicationId=bad"),
    ...["http://eastus.in.applicationinsights.azure.com/", "https://other.invalid/", "https://user@eastus.in.applicationinsights.azure.com/",
      "https://eastus.in.applicationinsights.azure.com/?private=x", "https://eastus.in.applicationinsights.azure.com/path", "not-a-url"]
      .map(endpoint => `InstrumentationKey=${key};IngestionEndpoint=${endpoint}`)]) assert.equal(validExperimentConnection(value), false);
});

test("invalid events and absent configuration never initialize or call the SDK", async () => {
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


test("the real SDK client remains manual-only with no inherited user tags", async () => {
  await assert.rejects(() => createManualExperimentClient("private"));
  // Construction configures the lazy SDK but never tracks or exports an event.
  const client = await createManualExperimentClient(connection);
  for (const key of ["enableAutoCollectRequests", "enableAutoCollectDependencies", "enableAutoCollectConsole",
    "enableAutoCollectExternalLoggers", "enableAutoCollectExceptions", "enableAutoCollectPerformance",
    "enableAutoCollectPreAggregatedMetrics", "enableAutoCollectHeartbeat", "enableAutoCollectExtendedMetrics",
    "enableAutoCollectIncomingRequestAzureFunctions", "enableAutoDependencyCorrelation", "enableSendLiveMetrics",
    "enableUseDiskRetryCaching", "enableInternalDebugLogging", "enableInternalWarningLogging"] as const) assert.equal(client.config[key], false);
  assert.deepEqual(client.commonProperties, {});
  assert.deepEqual(client.context.tags, { "ai.cloud.role": "s3rch" });
  assert.equal((client as unknown as { _useGlobalProviders: boolean })._useGlobalProviders, false);
});
