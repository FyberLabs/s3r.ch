import { createHash } from "node:crypto";
import { objectPrincipal } from "./identity/forum-authority-records";
import { parseForumObjectRecord, type UnverifiedObjectRecord } from "./identity/forum-object-record";
import { RecordConflict, type RecordStore } from "./record-store";

const MAX = 8;
function scope(object: string) {
  const owner = object.startsWith("media_") && objectPrincipal(object);
  if (!owner) throw Error("Invalid media object");
  return { owner, name: "ownership-v1-" + createHash("sha256").update(owner).digest("hex") };
}
export class MediaRegistrationCapacity extends Error {}
/** Parsing is not admission: callers verify current signing authority before
 * each write and again on every use. No reader grants or secret keys live here. */
export function mediaRegistration(input: unknown): UnverifiedObjectRecord | null {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join() !== "issuedAt,object,owner,sig") return null;
  const parsed = parseForumObjectRecord(input);
  return parsed?.record.object.startsWith("media_") ? parsed.record : null;
}
function decode(bytes: Uint8Array, owner: string): UnverifiedObjectRecord[] {
  if (bytes.length > 128 * 1024) throw Error("Invalid media registrations");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || Object.keys(value).sort().join() !== "entries,version" || value.version !== 1 ||
      !Array.isArray(value.entries) || value.entries.length > MAX) throw Error("Invalid media registrations");
  const entries = value.entries.map(mediaRegistration) as (UnverifiedObjectRecord | null)[];
  if (entries.some(row => !row || row.owner !== owner) || new Set(entries.map(row => row!.object)).size !== entries.length) throw Error("Invalid media registrations");
  return entries as UnverifiedObjectRecord[];
}
export function createMediaRegistrationStore(records: RecordStore) {
  return Object.freeze({
    async get(object: string, signal: AbortSignal) {
      const { owner, name } = scope(object);
      const saved = await records.get("media", name, signal); signal.throwIfAborted();
      return saved ? decode(saved.bytes, owner).find(row => row.object === object) ?? null : null;
    },
    async admit(input: UnverifiedObjectRecord, signal: AbortSignal, authorized: () => Promise<boolean>) {
      const record = mediaRegistration(input);
      if (!record) throw Error("Invalid media registration");
      const { owner, name } = scope(record.object);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const saved = await records.get("media", name, signal), entries = saved ? decode(saved.bytes, owner) : [];
        const position = entries.findIndex(row => row.object === record.object), previous = entries[position];
        if (previous) {
          if (JSON.stringify(previous) === JSON.stringify(record)) return;
          if (record.owner !== previous.owner || record.issuedAt <= previous.issuedAt) throw new RecordConflict();
          entries[position] = record;
        } else {
          if (entries.length >= MAX) throw new MediaRegistrationCapacity();
          entries.push(record);
        }
        if (!await authorized()) throw Error("Media registration authorization changed");
        signal.throwIfAborted();
        try {
          await records.put("media", name, new TextEncoder().encode(JSON.stringify({ version: 1, entries })), saved?.revision ?? null, signal);
          return;
        } catch (error) { if (!(error instanceof RecordConflict)) throw error; }
      }
      throw new RecordConflict();
    },
    async remove(object: string, signal: AbortSignal, authorized: () => Promise<boolean>) {
      const { owner, name } = scope(object);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const saved = await records.get("media", name, signal);
        const entries = saved ? decode(saved.bytes, owner) : [];
        const next = entries.filter(row => row.object !== object);
        if (next.length === entries.length) return;
        if (!await authorized()) throw Error("Media registration authorization changed");
        signal.throwIfAborted();
        try {
          await records.put("media", name, new TextEncoder().encode(JSON.stringify({ version: 1, entries: next })), saved!.revision, signal);
          return;
        } catch (error) { if (!(error instanceof RecordConflict)) throw error; }
      }
      throw new RecordConflict();
    },
  });
}
