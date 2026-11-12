import assert from "node:assert/strict";
import test from "node:test";
import { createExperimentEmitter, hashExperimentAssignment, parseExperimentPayload, type ExperimentEventType } from "./experiment-contract";
const secret = new Uint8Array(32).fill(97);
const payload = { experiment_key: "feed_layout", variant: "control", assignment_hash: hashExperimentAssignment("anonymous-fixture", secret), surface: "s3r.ch" };

test("assignment hashing matches the shared Python contract and is deterministic", () => {
  assert.equal(hashExperimentAssignment("anonymous-fixture", secret), "b0e5c9d9f222d0a0cc9d27da871b0bdb779de4ba68bbcceb7474c9b33574e1e7");
  assert.notEqual(hashExperimentAssignment("other", secret), payload.assignment_hash);
  assert.notEqual(hashExperimentAssignment("anonymous-fixture", new Uint8Array(32).fill(98)), payload.assignment_hash);
  for (const id of ["", "x".repeat(4097), null]) assert.throws(() => hashExperimentAssignment(id as string, secret));
  assert.throws(() => hashExperimentAssignment("id", new Uint8Array(31)));
  assert.throws(() => hashExperimentAssignment("id", "a".repeat(32) as unknown as Uint8Array));
});

test("events contain only shared configuration fields and a keyed assignment hash", () => {
  assert.deepEqual(parseExperimentPayload(payload), payload);
  assert.ok(Object.isFrozen(parseExperimentPayload(payload)));
  assert.deepEqual(parseExperimentPayload({ ...payload, release_tag: "0.1.20" }), { ...payload, release_tag: "0.1.20" });
  for (const field of ["email", "name", "wallet", "sea_public_key", "user_id", "cookie", "ip", "user_agent", "age", "date_of_birth", "prompt", "message", "metadata"]) {
    assert.equal(parseExperimentPayload({ ...payload, [field]: "private" }), null);
  }
});

test("malformed labels, hashes and optional fields are refused", () => {
  for (const input of [null, [], true, "event", {}, { ...payload, surface: "portal" },
    ...["", "A", "a".repeat(65), "a\nb", 12].flatMap(value => [
      { ...payload, experiment_key: value }, { ...payload, variant: value }]),
    ...["a".repeat(63), "A".repeat(64), "g".repeat(64), 12].map(assignment_hash => ({ ...payload, assignment_hash })),
    ...[null, "", "a".repeat(129), "private content", 12].map(release_tag => ({ ...payload, release_tag }))]) {
    assert.equal(parseExperimentPayload(input), null);
  }
});

test("the first-party sink receives explicit exposure/conversion only and cannot break a request", async () => {
  const calls: unknown[] = [];
  const emit = createExperimentEmitter(async (...args) => { calls.push(args); });
  assert.equal(calls.length, 0);
  for (const type of ["experiment.exposure.v1", "experiment.conversion.v1"] as const) assert.equal(await emit(type, payload), true);
  assert.equal(calls.length, 2);
  assert.equal(await emit("other" as ExperimentEventType, payload), false);
  assert.equal(await emit("experiment.exposure.v1", { ...payload, email: "private" }), false);
  assert.equal(calls.length, 2);
  assert.equal(await createExperimentEmitter(async () => { throw Error("private failure"); })("experiment.conversion.v1", payload), false);
});


test("accessors and hostile objects cannot change validated values before emission", async () => {
  let reads = 0, writes = 0;
  const accessor = { ...payload, get variant() { reads++; return reads < 3 ? "control" : { email: "private", message: "private" }; } };
  const emit = createExperimentEmitter(async () => { writes++; });
  assert.equal(await emit("experiment.exposure.v1", accessor), false);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(parseExperimentPayload(new Proxy({}, { ownKeys() { throw Error("private"); } })), null);
  assert.equal(parseExperimentPayload({ ...payload, [Symbol("private")]: "private" }), null);
  assert.equal(parseExperimentPayload(Object.defineProperty({ ...payload }, "email", { value: "private" })), null);
});


test("revoked proxies are isolated before array inspection", async () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.equal(parseExperimentPayload(proxy.proxy), null);
  assert.equal(await createExperimentEmitter(async () => { assert.fail("sink must not run"); })("experiment.exposure.v1", proxy.proxy), false);
});
