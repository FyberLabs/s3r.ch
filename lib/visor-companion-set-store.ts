import { createHash } from "node:crypto";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { RecordConflict, type RecordStore } from "./record-store";

export type VisorCompanionSetSnapshot = Readonly<{
  setId: string;
  setGeneration: string;
  companions: ReadonlyMap<string, Readonly<{ session: string; generation: string; principal: string }>>;
}>;

export type VisorCompanionSetStore = Readonly<{
  read(tenant: string, owner: string, machineId: string): Promise<VisorCompanionSetSnapshot | null>;
  write(tenant: string, owner: string, machineId: string, snapshot: VisorCompanionSetSnapshot): Promise<void>;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function encode(snapshot: VisorCompanionSetSnapshot): Uint8Array {
  const companions = [...snapshot.companions.entries()].map(([companion, row]) =>
    Object.freeze({ companion, session: row.session, generation: row.generation, principal: row.principal }));
  companions.sort((a, b) => a.companion.localeCompare(b.companion));
  const text = JSON.stringify({ version: 1, setId: snapshot.setId, setGeneration: snapshot.setGeneration, companions });
  if (new TextEncoder().encode(text).byteLength > 16384) throw new Error("Visor companion set capacity");
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): VisorCompanionSetSnapshot {
  if (bytes.byteLength > 16384) throw new Error("Invalid visor companion set");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || value.version !== 1 || !uuid.test(value.setId) || !uuid.test(value.setGeneration) ||
      !Array.isArray(value.companions) || value.companions.length > 8) throw new Error("Invalid visor companion set");
  const companions = new Map<string, Readonly<{ session: string; generation: string; principal: string }>>();
  for (const row of value.companions) {
    if (!row || Object.keys(row).sort().join() !== "companion,generation,principal,session" ||
        !uuid.test(row.companion) || !uuid.test(row.session) || !uuid.test(row.generation) ||
        typeof row.principal !== "string" || companions.has(row.companion)) throw new Error("Invalid visor companion set");
    companions.set(row.companion, Object.freeze({ session: row.session, generation: row.generation, principal: row.principal }));
  }
  return Object.freeze({ setId: value.setId, setGeneration: value.setGeneration, companions });
}

function recordName(forumId: string, tenant: string, owner: string, machineId: string) {
  const digest = createHash("sha256").update(JSON.stringify(["visor-companion-v1", forumId, tenant, owner, machineId])).digest("hex");
  return "vc-" + digest.slice(0, 56);
}

/** Durable companion-set fencing through the tenant record store (Postgres-backed in production). */
export function createRecordVisorCompanionSetStore(records: RecordStore, forumId: string): VisorCompanionSetStore {
  if (typeof forumId !== "string" || !forumId.startsWith("forum_")) throw new Error("Live forum scope required");
  return Object.freeze({
    async read(tenant, owner, machineId) {
      if (!uuid.test(tenant) || !uuid.test(machineId)) throw new Error("Invalid visor companion scope");
      const saved = await records.get("cache", recordName(forumId, tenant, owner, machineId));
      return saved ? decode(saved.bytes) : null;
    },
    async write(tenant, owner, machineId, snapshot) {
      if (!uuid.test(tenant) || !uuid.test(machineId)) throw new Error("Invalid visor companion scope");
      const name = recordName(forumId, tenant, owner, machineId);
      const body = encode(snapshot);
      for (let attempt = 0; attempt < 4; attempt++) {
        const saved = await records.get("cache", name);
        if (saved) decode(saved.bytes);
        try {
          await records.put("cache", name, body, saved?.revision ?? null);
          return;
        } catch (error) {
          if (!(error instanceof RecordConflict)) throw error;
        }
      }
      throw new RecordConflict();
    },
  });
}

export function configuredVisorCompanionSetStore(env: Readonly<Record<string, string | undefined>>,
  forumId: string, fetcher: typeof fetch = fetch): VisorCompanionSetStore | undefined {
  if (env.S3RCH_AUTHORITY_BACKEND !== "acl") return undefined;
  const origin = env.S3RCH_STATEMENT_SOURCE_ORIGIN, tenant = env.S3RCH_STATEMENT_SOURCE_TENANT_ID, apiKey = env.S3RCH_STATEMENT_SOURCE_API_KEY;
  if (!origin || !tenant || !apiKey) return undefined;
  return createRecordVisorCompanionSetStore(createSpanopticonRecordStore({ origin, tenant, apiKey }, fetcher), forumId);
}

/** Tests only: two instances over one backing store model separate processes. */
export function createMemoryVisorCompanionSetStore(): VisorCompanionSetStore & { clear(): void } {
  const rows = new Map<string, VisorCompanionSetSnapshot>();
  const key = (tenant: string, owner: string, machineId: string) => JSON.stringify([tenant, owner, machineId]);
  return {
    async read(tenant, owner, machineId) {
      const hit = rows.get(key(tenant, owner, machineId));
      return hit ? structuredClone({ ...hit, companions: new Map(hit.companions) }) : null;
    },
    async write(tenant, owner, machineId, snapshot) {
      rows.set(key(tenant, owner, machineId), structuredClone({ ...snapshot, companions: new Map(snapshot.companions) }));
    },
    clear() { rows.clear(); },
  };
}

export function createSimulatedRecordStore(): RecordStore & { clear(): void } {
  const rows = new Map<string, { bytes: Uint8Array; revision: string }>();
  let sequence = 0;
  const bucket = (namespace: string, name: string) => `${namespace}/${name}`;
  return {
    async get(namespace, name) {
      const hit = rows.get(bucket(namespace, name));
      return hit ? { bytes: new Uint8Array(hit.bytes), revision: hit.revision } : null;
    },
    async put(namespace, name, bytes, expected) {
      const id = bucket(namespace, name);
      const current = rows.get(id);
      if (expected === null) { if (current) throw new RecordConflict(); }
      else if (!current || current.revision !== expected) throw new RecordConflict();
      const revision = (++sequence).toString(16).padStart(64, "0");
      rows.set(id, { bytes: new Uint8Array(bytes), revision });
      return revision;
    },
    async delete(namespace, name, expected) {
      const id = bucket(namespace, name);
      const current = rows.get(id);
      if (!current || current.revision !== expected) throw new RecordConflict();
      rows.delete(id);
    },
    clear() { rows.clear(); sequence = 0; },
  };
}