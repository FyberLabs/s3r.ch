import test from "node:test";
import assert from "node:assert/strict";
import { createExperimentOutbox, type ExperimentRecordStore } from "./experiment-outbox";
import { withTerminalRun, type TerminalRunAuthority } from "./identity/terminal-run";
import type { ExperimentEvent } from "./experiment-runtime";
// Pure unit substitutions: no HTTP, database, signing, or real sink.
const event: ExperimentEvent = { event_id: "12345678-1234-4234-8234-123456789abc", event_type: "experiment.exposure.v1",
  payload: { experiment_key: "signup", variant: "treatment", assignment_hash: "a".repeat(64), surface: "s3r.ch" } };
function fixture() {
  let value: string | null = null, revision = 0;
  const state = { run: "original", active: true, completed: 0, sends: 0, uncertain: false };
  const store: ExperimentRecordStore = {
    async read() { return value === null ? null : { value, revision: String(revision) }; },
    async write(_name, next, expected) {
      if (expected !== (value === null ? null : String(revision))) return false;
      value = next; revision++; return true;
    },
  };
  const authority: TerminalRunAuthority = {
    async admit() { return { binding: { run: state.run, generation: "a".repeat(64) }, operation: "12345678-1234-1234-1234-123456789abc" }; },
    async active() { return state.active; }, async authorizeToken() { return true; }, async complete() { state.completed++; },
  };
  const open = () => createExperimentOutbox({ store, consentId: "b".repeat(64), retentionUntil: 10000, clock: () => 100, permitted: () => true,
    sinks: { first: { supportedEventTypes: ["experiment.exposure.v1"], async send() { state.sends++; if (state.uncertain) throw Error("uncertain receipt"); } } } });
  const run = <T>(work: () => Promise<T>) => withTerminalRun({} as Request, authority, work, () => true);
  return { state, store, open, run, saved: () => JSON.parse(value!) };
}
test("persisted outbox cannot be relabelled, drained or erased by successor or absent admission", async () => {
  const h = fixture(); await h.run(() => h.open().retain(event));
  assert.deepEqual(h.saved().nightly_run, { run: "original", generation: "a".repeat(64) });
  h.state.run = "successor";
  await assert.rejects(h.run(() => h.open().flush()));
  await assert.rejects(h.run(() => h.open().retain(event)));
  await assert.rejects(h.run(() => h.open().erase()));
  await assert.rejects(h.open().flush());
  assert.equal(h.state.sends, 0);
  h.state.run = "original"; await h.run(() => h.open().flush());
  assert.equal(h.state.sends, 1);
  await h.run(() => h.open().erase());
  assert.equal(h.saved().nightly_run.run, "original");
  assert.equal(h.saved().revoked, true);
});
test("legacy ledger is never adopted by a newly admitted run", async () => {
  const h = fixture(); await h.open().retain(event);
  await assert.rejects(h.run(() => h.open().flush())); assert.equal(h.state.sends, 0);
});
test("seal after send waits for final persistence before completing admitted work", async () => {
  const h = fixture(); await h.run(() => h.open().retain(event)); h.state.completed = 0;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const write = h.store.write;
  h.store.write = async (name, value, revision) => {
    if (JSON.parse(value).rows.some((r: { delivered: string[] }) => r.delivered.includes("first"))) { enter(); await paused; }
    return write(name, value, revision);
  };
  const result = assert.rejects(h.run(() => h.open().flush()));
  await entered; h.state.active = false;
  assert.equal(h.state.sends, 1); assert.equal(h.state.completed, 0);
  release(); await result;
  assert.equal(h.state.completed, 1); assert.deepEqual(h.saved().rows[0].delivered, ["first"]);
});
test("ambiguous sink outcome retains pending admission", async () => {
  const h = fixture(); await h.run(() => h.open().retain(event)); h.state.completed = 0; h.state.uncertain = true;
  await assert.rejects(h.run(() => h.open().flush()), /uncertain/);
  assert.equal(h.state.completed, 0); assert.equal(h.state.sends, 1);
});
