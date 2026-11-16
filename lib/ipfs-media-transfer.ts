/** Unmounted browser composition; callers authenticate grants and own provider/consent policy. */
import { sealMedia, openMedia, type MediaBinding } from "./media-crypto";
import { assembleMediaBlocks, describeMediaBlocks, parseMediaBlockManifest, IPFS_MEDIA_BLOCK_BYTES } from "./ipfs-media-blocks";
import type { createKuboBlockClient } from "./ipfs-kubo-client";
type Blocks = ReturnType<typeof createKuboBlockClient>;
const unavailable = () => new Error("IPFS media unavailable");
export function createIpfsMediaTransfer(options: {blocks: Blocks; current: () => boolean; signal: AbortSignal}) {
  const {blocks, current, signal} = options;
  // One whole-media operation per instance bounds retained copies during Web Crypto work.
  let busy = false;
  function check() { if (signal.aborted || !current()) throw unavailable(); }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    check(); if (busy) throw unavailable(); busy = true;
    try { return await work(); } finally { busy = false; }
  }
  return Object.freeze({
    /** Transfer the returned key only through the existing private grant model.
     * Failure may leave ciphertext at the provider; it returns no usable grant. */
    upload(plaintext: Uint8Array, binding: MediaBinding): Promise<{manifest: string; key: Uint8Array}> {
      return run(async () => {
        const sealed = await sealMedia(plaintext, binding);
        let returned = false;
        try {
          check(); const manifest = await describeMediaBlocks(sealed.bytes); check();
          for (let index = 0; index < manifest.blocks.length; index++) {
            check();
            const block = sealed.bytes.subarray(index * IPFS_MEDIA_BLOCK_BYTES, (index + 1) * IPFS_MEDIA_BLOCK_BYTES);
            if (await blocks.put(block) !== manifest.blocks[index]) throw unavailable();
            check();
          }
          const result = {manifest: JSON.stringify(manifest), key: sealed.key};
          returned = true; return result;
        } finally { sealed.bytes.fill(0); if (!returned) sealed.key.fill(0); }
      });
    },
    /** Manifest, binding and key must come from a current authenticated private grant. */
    download(manifestJson: string, key: Uint8Array, binding: MediaBinding): Promise<Uint8Array> {
      return run(async () => {
        const manifest = parseMediaBlockManifest(manifestJson);
        if (!(key instanceof Uint8Array) || key.length !== 32) throw unavailable();
        const rawKey = new Uint8Array(key), bound = {tenant: binding?.tenant, object: binding?.object};
        const downloaded: Uint8Array[] = []; let stored: Uint8Array | undefined, plaintext: Uint8Array | undefined;
        let returned = false;
        try {
          for (let index = 0; index < manifest.blocks.length; index++) {
            check();
            const size = Math.min(IPFS_MEDIA_BLOCK_BYTES, manifest.bytes - index * IPFS_MEDIA_BLOCK_BYTES);
            const bytes = await blocks.get(manifest.blocks[index], size); check();
            if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw unavailable();
            downloaded.push(new Uint8Array(bytes));
          }
          check(); stored = await assembleMediaBlocks(manifestJson, downloaded); check();
          plaintext = await openMedia(stored, manifest.sha256, rawKey, bound); check();
          returned = true; return plaintext;
        } finally {
          rawKey.fill(0); stored?.fill(0); for (const block of downloaded) block.fill(0);
          if (!returned) plaintext?.fill(0);
        }
      });
    },
  });
}
