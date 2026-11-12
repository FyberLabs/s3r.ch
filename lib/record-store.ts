/** Conditional named bytes; providers never decide end-user access grants. */
export const RECORD_BYTES_MAX = 8 * 1024 * 1024;
export type RecordNamespace = "cache" | "recovery" | "fixtures" | "media";
export type StoredRecord = Readonly<{ bytes: Uint8Array; revision: string }>;
export class RecordConflict extends Error {
  constructor() { super("Tenant record changed"); this.name = "RecordConflict"; }
}
export interface RecordStore {
  get(namespace: RecordNamespace, name: string, signal?: AbortSignal): Promise<StoredRecord | null>;
  /** null creates only if absent; a revision replaces only that revision. */
  put(namespace: RecordNamespace, name: string, bytes: Uint8Array, expected: string | null, signal?: AbortSignal): Promise<string>;
  delete(namespace: RecordNamespace, name: string, expected: string, signal?: AbortSignal): Promise<void>;
}
