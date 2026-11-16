/** Optional local ciphertext reuse; not a grant authority or availability guarantee. */
import { IPFS_MEDIA_BLOCK_BYTES, rawMediaBlockCid } from "./ipfs-media-blocks";
import type { createKuboBlockClient } from "./ipfs-kubo-client";
import type { createLocalCiphertextCache } from "./ipfs-local-cache";
export function createCachedMediaBlocks(options: {
  provider: ReturnType<typeof createKuboBlockClient>;
  cache?: ReturnType<typeof createLocalCiphertextCache>;
  current: () => boolean;
  signal: AbortSignal;
}) {
  const {provider, cache, current, signal} = options;
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
      check();const cid = await provider.put(bytes);check();return cid;
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
