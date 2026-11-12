import { fromGunNode, type FeedItem, type SourcePull } from "./feed-types";
import type { MemoryStore } from "./gun-server";
import { canonicalKey } from "./merge";
import { reconcileSourceWindows } from "./source-windows";
import { RECORD_BYTES_MAX, RecordConflict, type RecordStore } from "./record-store";

const fail = () => new Error("Public feed cache unavailable");
export function encodeFeedCache(store: MemoryStore): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, items: [...store.items.values()],
    sourceWindows: [...store.windows], retiredIds: [], seededAt: store.seededAt,
    sourcesOk: store.sourcesOk, sourcesTried: store.sourcesTried,
    error: store.error ? "The last public feed refresh failed." : null }));
  if (bytes.length > RECORD_BYTES_MAX) throw fail();
  return bytes;
}
export function decodeFeedCache(bytes: Uint8Array): MemoryStore {
  try {
    if (!bytes.length || bytes.length > RECORD_BYTES_MAX) throw fail();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || value.version !== 1 || !Array.isArray(value.items) || !Array.isArray(value.sourceWindows) ||
        !Array.isArray(value.retiredIds) || (value.seededAt !== null && (typeof value.seededAt !== "string" || !Number.isFinite(Date.parse(value.seededAt)))) ||
        !Number.isSafeInteger(value.sourcesOk) || !Number.isSafeInteger(value.sourcesTried) || value.sourcesOk < 0 || value.sourcesTried < value.sourcesOk ||
        (value.error !== null && typeof value.error !== "string")) throw fail();
    function rows(input: unknown[]): FeedItem[] {
      return input.map(row => {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw fail();
        const fields = row as Record<string, unknown>;
        if (["id", "kind", "author", "body", "permalink", "provenance"].some(key => typeof fields[key] !== "string") ||
            typeof fields.ts !== "number" || !Number.isFinite(fields.ts) || !Array.isArray(fields.tags) ||
            fields.tags.some(tag => typeof tag !== "string")) throw fail();
        const item = fromGunNode(row);
        if (!item || canonicalKey(item) !== item.id) throw fail();
        return item;
      });
    }
    const items = new Map(rows(value.items).map(item => [item.id, item]));
    if (items.size !== value.items.length) throw fail();
    const windows = new Map<string, FeedItem[]>();
    for (const entry of value.sourceWindows) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0] || windows.has(entry[0]) || !Array.isArray(entry[1])) throw fail();
      const entries = rows(entry[1]);
      if (new Set(entries.map(item => item.id)).size !== entries.length || entries.some(item => !items.has(item.id))) throw fail();
      windows.set(entry[0], entries);
    }
    if (value.retiredIds.some((id: unknown) => typeof id !== "string" || !id || items.has(id))) throw fail();
    return { items, windows, retired: new Set<string>(value.retiredIds), seededAt: value.seededAt,
      sourcesOk: value.sourcesOk, sourcesTried: value.sourcesTried, error: value.error ? "The last public feed refresh failed." : null };
  } catch { throw fail(); }
}

/** A conflict starts a fresh source fetch against the new authoritative record. */
export function tenantFeedCache(records: RecordStore, local: () => MemoryStore, publish: (store: MemoryStore) => void, markAdopted: () => void) {
  let observed = false;
  async function current() {
    const record = await records.get("cache", "public-feed");
    if (!record && (observed || local().tenantRecordInitialized)) throw fail();
    if (record) observed = true;
    return { state: record ? decodeFeedCache(record.bytes) : local(), revision: record?.revision ?? null };
  }
  return {
    async restore() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await current();
        if (stored.revision !== null) { markAdopted(); publish(stored.state); return; }
        try {
          markAdopted();
          await records.put("cache", "public-feed", encodeFeedCache(stored.state), null);
          observed = true; publish(stored.state); return;
        } catch (error) { if (!(error instanceof RecordConflict)) throw fail(); }
      }
      throw fail();
    },
    async refresh(pull: () => Promise<SourcePull>) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await current();
        const pulled = await pull(), seededAt = new Date().toISOString();
        const next: MemoryStore = { ...reconcileSourceWindows(stored.state, pulled), seededAt,
          sourcesOk: pulled.sourcesOk, sourcesTried: pulled.sourcesTried, error: pulled.error };
        try {
          markAdopted();
          await records.put("cache", "public-feed", encodeFeedCache(next), stored.revision);
        } catch (error) {
          if (error instanceof RecordConflict) continue;
          throw fail();
        }
        observed = true;
        publish(next);
        return { pulled, seededAt, written: new Set((pulled.windows ?? []).flatMap(window => window.items.map(canonicalKey)).filter(Boolean)).size };
      }
      throw fail();
    },
  };
}
