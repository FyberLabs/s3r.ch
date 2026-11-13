import { randomUUID } from "node:crypto";
import { parseExperimentPayload } from "./experiment-contract";
import type { ExperimentEvent, ExperimentSink } from "./experiment-runtime";

export type ExperimentRecordStore = {
  read(name: string): Promise<{ value: string; revision: string } | null>;
  /** null means create if absent. Returns false only for a conditional conflict. */
  write(name: string, value: string, revision: string | null): Promise<boolean>;
};
type Row = { event: ExperimentEvent; expires: number; delivered: string[] };
type Ledger = { version: 1; expires: number; revoked: boolean; rows: Row[] };
function validEvent(event: ExperimentEvent): boolean {
  return !!event && Object.keys(event).sort().join() === "event_id,event_type,payload" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.event_id) &&
    ["experiment.exposure.v1", "experiment.conversion.v2"].includes(event.event_type) &&
    parseExperimentPayload(event.payload, event.event_type) !== null;
}

/** One bounded record per consent session. Storage and sink failures propagate;
 * the caller must not report delivery until all configured sinks accept it. */
export function createExperimentOutbox(input: {
  store: ExperimentRecordStore; consentId: string; retentionUntil: number;
  sinks: Readonly<Record<string, ExperimentSink>>; permitted(): boolean; healthy?(key: string): boolean; clock?: () => number;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.consentId) || !Number.isSafeInteger(input.retentionUntil) ||
      !Object.keys(input.sinks).length || Object.keys(input.sinks).some(k => !/^[a-z][a-z0-9_-]{0,31}$/.test(k))) throw Error("Invalid outbox binding");
  const name = `s3rch-outbox-${input.consentId}`;
  const now = input.clock ?? Date.now;
  const permitted = () => input.permitted() && now() < input.retentionUntil;
  async function load() {
    const record = await input.store.read(name);
    if (!record) return { ledger: { version: 1, expires: input.retentionUntil, revoked: false, rows: [] } as Ledger, revision: null };
    if (record.value.length > 65536) throw Error("Invalid experiment outbox");
    const ledger = JSON.parse(record.value) as Ledger;
    if (!ledger || Object.keys(ledger).sort().join() !== "expires,revoked,rows,version" || ledger.version !== 1 || ledger.expires !== input.retentionUntil || typeof ledger.revoked !== "boolean" || !Array.isArray(ledger.rows) || ledger.rows.length > 64 ||
        ledger.rows.some(r => !r || !Number.isSafeInteger(r.expires) || !Array.isArray(r.delivered) ||
          r.delivered.some(k => typeof k !== "string") || Object.keys(r).sort().join() !== "delivered,event,expires" || !validEvent(r.event))) throw Error("Invalid experiment outbox");
    return { ledger, revision: record.revision };
  }
  async function update(change: (rows: Row[]) => void) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!permitted()) throw Error("Experiment consent unavailable");
      const { ledger, revision } = await load();
      if (ledger.revoked) throw Error("Experiment consent revoked");
      ledger.rows = ledger.rows.filter(r => r.expires > now());
      change(ledger.rows);
      if (!permitted()) throw Error("Experiment consent unavailable");
      if (await input.store.write(name, JSON.stringify(ledger), revision)) return;
    }
    throw Error("Experiment outbox busy");
  }
  async function flush(targetId?: string): Promise<void> {
      if (!permitted()) throw Error("Experiment consent unavailable");
      const { ledger } = await load();
      if (ledger.revoked) throw Error("Experiment consent revoked");
      let busy = false, unsupported = false;
      for (const row of ledger.rows) {
        if (row.expires <= now()) continue;
        for (const [key, sink] of Object.entries(input.sinks)) {
          if (row.delivered.includes(key)) continue;
          // A retained v2 action must not block v1 delivery after a sink rollback.
          if (!sink.supportedEventTypes.includes(row.event.event_type)) { unsupported = true; continue; }
          // Claim through the same conditional record before the external send.
          // Reserved markers are additive to v1 string progress: older readers
          // ignore them, and the owning Storage contract remains unchanged.
          const prefix = `@lease:${key}:`, owner = randomUUID(), deadline = now() + 30000;
          const claim = `${prefix}${deadline}:${owner}`;
          let claimed = false;
          await update(rows => {
            claimed = false;
            const current = rows.find(r => r.event.event_id === row.event.event_id);
            if (!current || current.delivered.includes(key)) return;
            if (JSON.stringify(current.event) !== JSON.stringify(row.event)) throw Error("Experiment event changed");
            if (current.delivered.some(marker => marker.startsWith(prefix) && Number(marker.split(":")[2]) > now())) { busy = true; return; }
            current.delivered = current.delivered.filter(marker => !marker.startsWith(prefix));
            current.delivered.push(claim); claimed = true;
          });
          if (!claimed) continue;
          try {
            // Withdrawal may complete while a claim-write response is delayed.
            const { ledger: latest } = await load();
            const current = latest.rows.find(r => r.event.event_id === row.event.event_id);
            if (latest.revoked) throw Error("Experiment consent revoked");
            if (!current?.delivered.includes(claim) || now() >= deadline) throw Error("Experiment delivery claim expired");
            if (!permitted()) throw Error("Experiment consent unavailable");
            if (input.healthy && !input.healthy(row.event.payload.experiment_key)) throw Error("Experiment configuration unavailable");
            if (!sink.supportedEventTypes.includes(row.event.event_type)) throw Error("Experiment event unsupported");
            await sink.send(row.event);
            await update(rows => {
              const current = rows.find(r => r.event.event_id === row.event.event_id);
              if (!current?.delivered.includes(claim)) throw Error("Experiment delivery claim changed");
              current.delivered = current.delivered.filter(marker => marker !== claim);
              if (!current.delivered.includes(key)) current.delivered.push(key);
            });
          } catch (error) {
            // Failure releases only this request's claim. A crash leaves a
            // finite lease; recovery retries the unchanged stable event ID.
            await update(rows => {
              const current = rows.find(r => r.event.event_id === row.event.event_id);
              if (current) current.delivered = current.delivered.filter(marker => marker !== claim);
            }).catch(() => {});
            throw error;
          }
        }
      }
      if (targetId !== undefined) {
        const { ledger: latest } = await load();
        if (!permitted() || latest.revoked) throw Error("Experiment consent unavailable");
        const target = latest.rows.find(row => row.event.event_id === targetId);
        if (!target || !Object.keys(input.sinks).every(key => target.delivered.includes(key))) throw Error("Experiment delivery busy");
      } else if (unsupported) throw Error("Experiment event unsupported");
      else if (busy) throw Error("Experiment delivery busy");
  }
  return Object.freeze({
    async active(): Promise<boolean> {
      if (!permitted()) return false;
      const { ledger } = await load();
      return permitted() && !ledger.revoked;
    },
    async retain(event: ExperimentEvent) {
      if (!validEvent(event)) throw Error("Invalid experiment event");
      // A full pending queue must be able to recover before a new page's
      // action ID can be admitted. No new event is needed to authorize drain.
      const { ledger } = await load();
      if (ledger.rows.length >= 64 && !ledger.rows.some(row => Object.keys(input.sinks).every(key => row.delivered.includes(key)))) await flush();
      await update(rows => {
        const existing = rows.find(r => r.event.event_id === event.event_id);
        if (existing) {
          if (JSON.stringify(existing.event) !== JSON.stringify(event)) throw Error("Experiment event conflict");
          return;
        }
        if (rows.length >= 64) {
          // Keep recent completed IDs for retry deduplication, but never let
          // completed work prevent a new action or evict undelivered work.
          const completed = rows.findIndex(r => Object.keys(input.sinks).every(key => r.delivered.includes(key)));
          if (completed < 0) throw Error("Experiment outbox full");
          rows.splice(completed, 1);
        }
        rows.push({ event, expires: Math.min(input.retentionUntil, now() + 86400_000), delivered: [] });
      });
    },
    flush,
    async erase(): Promise<void> {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { revision } = await load();
        // Keep only a revocation marker so a concurrent old request cannot
        // recreate the deleted events using its previously valid consent token.
        if (await input.store.write(name, JSON.stringify({ version: 1, expires: input.retentionUntil, revoked: true, rows: [] }), revision)) return;
      }
      throw Error("Experiment deletion busy");
    },
  });
}
