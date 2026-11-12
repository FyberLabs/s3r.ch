/** Opaque immutable bytes. Application authorization and encryption stay above
 * this boundary; knowing an address never grants a reader access. */
export const OBJECT_BYTES_MAX = 64 * 1024 * 1024;
export interface ObjectStore {
  put(address: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(address: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  delete(address: string, signal?: AbortSignal): Promise<void>;
}
