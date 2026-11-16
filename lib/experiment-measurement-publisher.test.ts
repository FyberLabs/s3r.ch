import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeasurementPublisher, privateMeasurementSecret, type MeasurementRow } from "./experiment-measurement-publisher";

const binding = { endpoint: "https://test.ingest.monitor.azure.com", rule: "dcr-" + "a".repeat(32),
  directory: "12345678-1234-4234-8234-123456789abc", clientId: "22345678-1234-4234-8234-123456789abc", secret: "server-only-private-secret" };
function rows(): MeasurementRow[] {
  const ActionId = randomUUID(), ObservedAt = Math.floor(Date.now() / 1000);
  return (["error_rate", "dependency_failure_rate", "latency_ms"] as const).map(Metric => ({ ActionId, ObservedAt, Experiment: "landing-message", Variant: "create", Metric, Value: 0 }));
}
const next = () => new Promise(resolve => setImmediate(resolve));

test("private credentials reject public permissions and symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "measurement-secret-"));
  try {
    const file = join(dir, "secret"), link = join(dir, "link");
    await writeFile(file, binding.secret, { mode: 0o600 });
    assert.equal(await privateMeasurementSecret(file), binding.secret);
    await symlink(file, link); await assert.rejects(privateMeasurementSecret(link));
    await chmod(file, 0o644); await assert.rejects(privateMeasurementSecret(file));
    await assert.rejects(privateMeasurementSecret("relative"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("server publisher uses isolated Azure authority and closed rows", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    if (new URL(String(url)).hostname === "login.microsoftonline.com") return new Response(JSON.stringify({ access_token: "server-ingest-token", token_type: "Bearer", expires_in: 3600 }));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer server-ingest-token");
    assert.equal(String(init?.body).includes(binding.secret), false);
    assert.equal(String(init?.body).includes("Tenant"), false);
    return new Response(null, { status: 204 });
  };
  const publisher = createMeasurementPublisher(binding, transport);
  const sample = rows(); assert.equal(publisher.publish(sample), true);
  await next(); assert.equal(calls.length, 2);
  assert.match(calls[1].url, /Custom-ExperimentGuardrail\?api-version=2023-01-01$/);
  assert.equal(publisher.publish(sample.map(row => ({ ...row, Source: "browser" }))), false);
  assert.equal(publisher.publish(sample.map(row => ({ ...row, ObservedAt: row.ObservedAt - 61 }))), false);
  assert.equal(publisher.publish(sample.map(row => ({ ...row, Value: NaN }))), false);
  publisher.close(); assert.equal(publisher.publish(rows()), false);
});

test("queue is bounded and failed delivery never retries through product outbox", async () => {
  let calls = 0; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const publisher = createMeasurementPublisher(binding, async () => { calls++; await wait; return new Response(null, { status: 503 }); });
  assert.equal(publisher.publish(rows()), true);
  for (let n = 0; n < 64; n++) assert.equal(publisher.publish(rows()), true);
  assert.equal(publisher.publish(rows()), false);
  publisher.close(); release(); await next(); assert.equal(calls, 1);
});

test("arbitrary destinations cannot receive publisher credentials", () => {
  for (const endpoint of ["http://test.ingest.monitor.azure.com", "https://foreign.test", "https://test.ingest.monitor.azure.com@foreign.test", "https://test.ingest.monitor.azure.com/?x=1"])
    assert.throws(() => createMeasurementPublisher({ ...binding, endpoint }));
});
