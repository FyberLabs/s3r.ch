/** Optional local ciphertext reuse; not a grant authority or availability guarantee. */
import { IPFS_MEDIA_BLOCK_BYTES, rawMediaBlockCid } from "./ipfs-media-blocks";
import type { createKuboBlockClient } from "./ipfs-kubo-client";
import type { createLocalCiphertextCache } from "./ipfs-local-cache";
export function createCachedMediaBlocks(options: {
  provider: ReturnType<typeof createKuboBlockClient>;
  cache?: ReturnType<typeof createLocalCiphertextCache>;
  /** Cache-only reads never dispatch to the provider, including on storage failure. */
  readPolicy?: "provider-allowed" | "cache-only";
  current: () => boolean;
  signal: AbortSignal;
}) {
  const {provider, cache, current, signal} = options;
  const readPolicy = options.readPolicy ?? "provider-allowed";
  if (readPolicy !== "provider-allowed" && readPolicy !== "cache-only") throw new Error("Invalid IPFS read policy");
  let active = 0;
  const unavailable = () => new Error("IPFS media unavailable");
  function check() {if (signal.aborted || current() !== true) throw unavailable();}
  async function verified(value: Uint8Array, cid: string, size: number) {
    if (!(value instanceof Uint8Array) || value.length !== size) throw unavailable();
    const copy = new Uint8Array(value);
    if (await rawMediaBlockCid(copy) !== cid) throw unavailable();
    check();return copy;
  }
  return Object.freeze({
    async put(bytes: Uint8Array): Promise<string> {
      check();
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > IPFS_MEDIA_BLOCK_BYTES || active >= 2) throw unavailable();
      active++;let copy: Uint8Array | undefined;
      try {
        copy = new Uint8Array(bytes);
        const cid = await rawMediaBlockCid(copy);check();
        // Keep the retained snapshot separate from an adapter's mutable input.
        if (await provider.put(new Uint8Array(copy)) !== cid) throw unavailable();
        check();
        if (cache) {
          try {await cache.put(cid, copy, signal);} catch { /* acknowledgement does not promise local retention */ }
        }
        check();return cid;
      } finally {copy?.fill(0);active--;}
    },
    async get(cid: string, size: number): Promise<Uint8Array> {
      check();
      if (typeof cid !== "string" || !/^bafkrei[a-z2-7]{52}$/.test(cid) || !Number.isSafeInteger(size) || size < 1 || size > IPFS_MEDIA_BLOCK_BYTES || active >= 2) throw unavailable();
      active++;
      try {
        if (cache) {
          try {const local = await cache.get(cid, signal);if (local) return await verified(local, cid, size);}
          catch { /* Corrupt, expired or unavailable cache is a miss, not authority. */ }
        }
        check();
        if (readPolicy === "cache-only") throw unavailable();
        const bytes = await verified(await provider.get(cid, size), cid, size);
        if (cache) {
          // Retention is best-effort; local quota must not invalidate verified provider bytes.
          try {check();await cache.put(cid, bytes, signal);} catch { /* no local availability claim */ }
        }
        check();return bytes;
      } finally {active--;}
    },
  });
}
