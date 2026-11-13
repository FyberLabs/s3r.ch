import test from "node:test";
import assert from "node:assert/strict";
import { createExperimentOutbox, type ExperimentRecordStore } from "./experiment-outbox";
import type { ExperimentEvent, ExperimentSink } from "./experiment-runtime";
const event: ExperimentEvent = { event_id: "12345678-1234-4234-8234-123456789abc", event_type: "experiment.exposure.v1",
  payload: { experiment_key: "signup", variant: "treatment", assignment_hash: "a".repeat(64), surface: "s3r.ch" } };
function memory() {
  let value: string | null = null, revision = 0;
  const store: ExperimentRecordStore = {
    async read() { return value === null ? null : { value, revision: String(revision) }; },
    async write(_name, next, expected) {
      if (expected !== (value === null ? null : String(revision))) return false;
      value = next; revision++; return true;
    },
  };
  return { store, value: () => value };
}
function open(store: ExperimentRecordStore, sinks: Record<string, ExperimentSink>, permitted = () => true, clock = () => 100) {
  return createExperimentOutbox({ store, sinks, consentId: "b".repeat(64), retentionUntil: 10000, permitted, clock });
}

test("restart retries only pending sinks with the original event ID", async () => {
  const m = memory(); const ids: string[] = []; let offline = true, first = 0;
  const sinks: Record<string, ExperimentSink> = {
    first: { supportedEventTypes: ["experiment.exposure.v1"], async send(e) { first++; ids.push(e.event_id); } },
    second: { supportedEventTypes: ["experiment.exposure.v1"], async send(e) { if (offline) throw Error("offline"); ids.push(e.event_id); } },
  };
  const a = open(m.store, sinks); await a.retain(event); await assert.rejects(a.flush, /offline/);
  const b = open(m.store, sinks); offline = false;
  await b.retain(event); await b.flush(); await b.flush();
  assert.equal(first, 1); assert.deepEqual(ids, [event.event_id, event.event_id]);
  await assert.rejects(() => b.retain({ ...event, payload: { ...event.payload, variant: "control" } }), /conflict/);
});

test("deletion retains only a revocation marker and prevents old requests recreating events", async () => {
  const m = memory(); const sinks: Record<string, ExperimentSink> = { first: { supportedEventTypes: ["experiment.exposure.v1"], async send() { assert.fail(); } } };
  const a = open(m.store, sinks), oldRequest = open(m.store, sinks);
  await a.retain(event); await a.erase();
  assert.deepEqual(JSON.parse(m.value()!), { version: 1, expires: 10000, revoked: true, rows: [] });
  await assert.rejects(() => oldRequest.retain(event), /revoked/);
  await assert.rejects(oldRequest.flush, /revoked/);
});

test("privacy revocation between sinks prevents the second delivery", async () => {
  const m = memory(); let allowed = true;
  const outbox = open(m.store, {
    first: { supportedEventTypes: ["experiment.exposure.v1"], async send() { allowed = false; } },
    second: { supportedEventTypes: ["experiment.exposure.v1"], async send() { assert.fail(); } },
  }, () => allowed);
  await outbox.retain(event); await assert.rejects(outbox.flush, /consent/);
});

test("expired events are never sent and malformed persisted private fields fail closed", async () => {
  const m = memory(); let time = 100;
  const sinks: Record<string, ExperimentSink> = { first: { supportedEventTypes: ["experiment.exposure.v1"], async send() { assert.fail(); } } };
  const outbox = open(m.store, sinks, () => true, () => time);
  await outbox.retain(event); time = 10000; await assert.rejects(outbox.flush, /consent/);
  const poisoned: ExperimentRecordStore = { async read() { return { revision: "1", value: JSON.stringify({ version: 1, expires: 10000, revoked: false, rows: [{ event: { ...event, payload: { ...event.payload, user_id: "private" } }, expires: 500, delivered: [] }] }) }; }, async write() { assert.fail(); } };
  await assert.rejects(open(poisoned, sinks).flush, /Invalid experiment outbox/);
});


test("configuration changes stop each subsequent sink and queued event", async () => {
  const m = memory(); let healthy = true, delivered = 0;
  const outbox = createExperimentOutbox({ store: m.store, consentId: "b".repeat(64), retentionUntil: 10000,
    permitted: () => true, clock: () => 100, healthy: key => { assert.equal(key, "signup"); return healthy; },
    sinks: {
      first: { supportedEventTypes: ["experiment.exposure.v1"], async send() { delivered++; healthy = false; } },
      second: { supportedEventTypes: ["experiment.exposure.v1"], async send() { assert.fail("disabled secondary delivery"); } },
    } });
  await outbox.retain(event);
  await outbox.retain({ ...event, event_id: "22345678-1234-4234-8234-123456789abc" });
  await assert.rejects(outbox.flush, /configuration/);
  assert.equal(delivered, 1);
});


test("completed withdrawal blocks the next sink after a delayed progress response", async () => {
  const m = memory(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const store: ExperimentRecordStore = { read: m.store.read, async write(name, value, revision) {
    const ok = await m.store.write(name, value, revision);
    if (ok && JSON.parse(value).rows.some((r: { delivered: string[] }) => r.delivered.includes("first"))) { entered(); await waiting; }
    return ok;
  } };
  const sinks: Record<string, ExperimentSink> = {
    first: { supportedEventTypes: ["experiment.exposure.v1"], async send() {} },
    second: { supportedEventTypes: ["experiment.exposure.v1"], async send() { assert.fail("withdrawn consent delivered"); } },
  };
  const queue = open(store, sinks); await queue.retain(event);
  const flush = queue.flush(); await started;
  await open(store, sinks).erase(); release();
  await assert.rejects(flush, /revoked/);
  assert.equal(await queue.active(), false);
});

test("completed rows release capacity while recent event IDs remain deduplicated", async () => {
  const m = memory(); let sent = 0;
  const queue = open(m.store, { primary: { supportedEventTypes: ["experiment.exposure.v1"], async send() { sent++; } } });
  let latest = event;
  for (let i = 0; i < 80; i++) {
    latest = { ...event, event_id: `${i.toString(16).padStart(8,"0")}-1234-4234-8234-123456789abc` };
    await queue.retain(latest); await queue.flush();
  }
  await queue.retain(latest); await queue.flush();
  assert.equal(sent, 80); assert.equal(JSON.parse(m.value()!).rows.length, 64);
});
test("independent concurrent flushes claim each sink before sending", async () => {
  const m = memory(); let sent = 0, release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const sink: ExperimentSink = { supportedEventTypes: ["experiment.exposure.v1"], async send() { sent++; started(); await new Promise<void>(resolve => { release = resolve; }); } };
  const first = open(m.store,{primary:sink}), second = open(m.store,{primary:sink});
  await first.retain(event); const pending = first.flush(); await began;
  await assert.rejects(second.flush(), /busy/); release(); await pending;
  await second.flush(); assert.equal(sent,1);
});
test("a crashed delivery claim expires without changing the retained action", async () => {
  const m = memory(); let time = 100, sent = 0;
  const sink: ExperimentSink = { supportedEventTypes: ["experiment.exposure.v1"], async send(value) { assert.deepEqual(value,event); sent++; } };
  const queue = open(m.store,{primary:sink},()=>true,()=>time);
  await queue.retain(event);
  const record=await m.store.read("ignored");const ledger=JSON.parse(record!.value);
  ledger.rows[0].delivered.push("@lease:primary:200:12345678-1234-4234-8234-123456789abc");
  await m.store.write("ignored",JSON.stringify(ledger),record!.revision);
  await assert.rejects(queue.flush(),/busy/);assert.equal(sent,0);
  time=201;await queue.flush();assert.equal(sent,1);
});
test("a full pending queue drains after outage before admitting a fresh page action", async () => {
  const m=memory();let offline=true,sent=0;
  const queue=open(m.store,{primary:{supportedEventTypes:["experiment.exposure.v1"],async send(){if(offline)throw Error("offline");sent++;}}});
  for(let i=0;i<64;i++)await queue.retain({...event,event_id:`${i.toString(16).padStart(8,"0")}-1234-4234-8234-123456789abc`});
  const fresh={...event,event_id:"ffffffff-1234-4234-8234-123456789abc"};
  await assert.rejects(queue.retain(fresh),/offline/);assert.equal(sent,0);
  offline=false;await queue.retain(fresh);await queue.flush();assert.equal(sent,65);
});
