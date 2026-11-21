import { createHash } from "node:crypto";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { RecordConflict, type RecordStore } from "./record-store";

type VisorCompanionBinding = Readonly<{ session: string; generation: string; principal: string }>;

export type VisorCompanionSetSnapshot = Readonly<{
  setId: string;
  setGeneration: string;
  companions: ReadonlyMap<string, VisorCompanionBinding>;
  retired: ReadonlyMap<string, VisorCompanionBinding>;
}>;

export type VisorCompanionSetEntry = Readonly<{
  snapshot: VisorCompanionSetSnapshot | null;
  revision: string | null;
}>;

export type VisorCompanionSetStore = Readonly<{
  read(tenant: string, owner: string, machineId: string): Promise<VisorCompanionSetEntry>;
  write(tenant: string, owner: string, machineId: string, snapshot: VisorCompanionSetSnapshot, expectedRevision: string | null): Promise<void>;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ACTIVE_COMPANIONS = 8;
const MAX_RETIRED_COMPANIONS = 8;
const sortedFieldNames = (row: Record<string, unknown>) => Object.keys(row).sort((a, b) => a.localeCompare(b));

function encode(snapshot: VisorCompanionSetSnapshot): Uint8Array {
  const rowList = (map: ReadonlyMap<string, VisorCompanionBinding>) =>
    [...map.entries()].map(([companion, row]) =>
      Object.freeze({ companion, session: row.session, generation: row.generation, principal: row.principal }))
      .sort((a, b) => a.companion.localeCompare(b.companion));
  if (snapshot.companions.size > MAX_ACTIVE_COMPANIONS || snapshot.retired.size > MAX_RETIRED_COMPANIONS) {
    throw new Error("Visor companion set capacity");
  }
  const text = JSON.stringify({
    version: 2, setId: snapshot.setId, setGeneration: snapshot.setGeneration,
    companions: rowList(snapshot.companions), retired: rowList(snapshot.retired),
  });
  if (new TextEncoder().encode(text).byteLength > 16384) throw new Error("Visor companion set capacity");
  return new TextEncoder().encode(text);
}

function decodeBindings(rows: unknown, out: Map<string, VisorCompanionBinding>, maxRows: number) {
  if (!Array.isArray(rows) || rows.length > maxRows) throw new Error("Invalid visor companion set");
  for (const row of rows) {
    if (!row || sortedFieldNames(row as Record<string, unknown>).join() !== "companion,generation,principal,session" ||
        !uuid.test(row.companion) || !uuid.test(row.session) || !uuid.test(row.generation) ||
        typeof row.principal !== "string" || out.has(row.companion)) throw new Error("Invalid visor companion set");
    out.set(row.companion, Object.freeze({ session: row.session, generation: row.generation, principal: row.principal }));
  }
}

function decode(bytes: Uint8Array): VisorCompanionSetSnapshot {
  if (bytes.byteLength > 16384) throw new Error("Invalid visor companion set");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || (value.version !== 1 && value.version !== 2) || !uuid.test(value.setId) || !uuid.test(value.setGeneration)) {
    throw new Error("Invalid visor companion set");
  }
  const companions = new Map<string, VisorCompanionBinding>();
  decodeBindings(value.companions, companions, MAX_ACTIVE_COMPANIONS);
  const retired = new Map<string, VisorCompanionBinding>();
  if (value.version === 2) decodeBindings(value.retired ?? [], retired, MAX_RETIRED_COMPANIONS);
  return Object.freeze({ setId: value.setId, setGeneration: value.setGeneration, companions, retired });
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
      return saved
        ? { snapshot: decode(saved.bytes), revision: saved.revision }
        : { snapshot: null, revision: null };
    },
    async write(tenant, owner, machineId, snapshot, expectedRevision) {
      if (!uuid.test(tenant) || !uuid.test(machineId)) throw new Error("Invalid visor companion scope");
      const name = recordName(forumId, tenant, owner, machineId);
      const body = encode(snapshot);
      await records.put("cache", name, body, expectedRevision);
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
  const revisions = new Map<string, string>();
  let sequence = 0;
  const key = (tenant: string, owner: string, machineId: string) => JSON.stringify([tenant, owner, machineId]);
  return {
    async read(tenant, owner, machineId) {
      const id = key(tenant, owner, machineId);
      const hit = rows.get(id);
      return hit
        ? { snapshot: structuredClone({ ...hit, companions: new Map(hit.companions), retired: new Map(hit.retired) }),
          revision: revisions.get(id) ?? null }
        : { snapshot: null, revision: null };
    },
    async write(tenant, owner, machineId, snapshot, expectedRevision) {
      const id = key(tenant, owner, machineId);
      const current = revisions.get(id) ?? null;
      if (expectedRevision === null) { if (current) throw new RecordConflict(); }
      else if (current !== expectedRevision) throw new RecordConflict();
      const revision = (++sequence).toString(16).padStart(64, "0");
      revisions.set(id, revision);
      rows.set(id, structuredClone({
        ...snapshot, companions: new Map(snapshot.companions), retired: new Map(snapshot.retired),
      }));
    },
    clear() { rows.clear(); revisions.clear(); sequence = 0; },
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