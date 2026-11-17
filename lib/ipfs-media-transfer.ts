/** Unmounted browser composition; callers authenticate grants and own provider/consent policy. */
import { sealMedia, openMedia, type MediaBinding } from "./media-crypto";
import { assembleMediaBlocks, describeMediaBlocks, parseMediaBlockManifest, rawMediaBlockCid, IPFS_MEDIA_BLOCK_BYTES } from "./ipfs-media-blocks";
import type { createKuboBlockClient } from "./ipfs-kubo-client";
type Blocks = ReturnType<typeof createKuboBlockClient>;
const unavailable = () => new Error("IPFS media unavailable");
export function createIpfsMediaTransfer(options: {blocks: Blocks; current: () => boolean; signal: AbortSignal}) {
  const {blocks, current, signal} = options;
  // One whole-media operation per instance bounds retained copies during Web Crypto work.
  let busy = false, prepared = false;
  function check() { if (signal.aborted || !current()) throw unavailable(); }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    check(); if (busy || prepared) throw unavailable(); busy = true;
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
    /** Retain one encrypted upload for at most 15 minutes. resume() is explicit;
     * acknowledged blocks are not resent, and failure releases no key/manifest. */
    prepareUpload(plaintext: Uint8Array, binding: MediaBinding) {
      return run(async () => {
        const sealed = await sealMedia(plaintext, binding);
        try {
          check(); const manifest = await describeMediaBlocks(sealed.bytes); check();
          const start = performance.now();
          if (!Number.isFinite(start)) throw unavailable();
          let lastTime = start, cursor = 0, running = false, retained = true;
          let state: "local-only" | "uploading" | "unavailable" | "acknowledged" | "disposed" | "expired" = "local-only";
          let timer: ReturnType<typeof setTimeout>;
          function release(next: typeof state) {
            if (!retained) return;
            retained = false; prepared = false; state = next;
            sealed.bytes.fill(0); sealed.key.fill(0);
            clearTimeout(timer); signal.removeEventListener("abort", abort);
          }
          const abort = () => release("disposed");
          function alive() {
            if (!retained) return false;
            const now = performance.now();
            if (!Number.isFinite(now) || now < lastTime || now - start >= 15 * 60_000) {release("expired");return false;}
            lastTime = now;
            let allowed = false;
            try { allowed = !signal.aborted && current(); } catch { /* no authority */ }
            if (!allowed) {release("disposed");return false;}
            return true;
          }
          prepared = true;
          timer = setTimeout(() => release("expired"), 15 * 60_000);
          signal.addEventListener("abort", abort, {once: true});
          if (!alive()) throw unavailable();
          return Object.freeze({
            status() {alive();return Object.freeze({state, acknowledgedBlocks: cursor, totalBlocks: manifest.blocks.length});},
            dispose() {release("disposed");},
            async resume(): Promise<{manifest: string; key: Uint8Array}> {
              if (!alive() || running) throw unavailable();
              running = true; state = "uploading";
              try {
                while (cursor < manifest.blocks.length) {
                  if (!alive()) throw unavailable();
                  const block = sealed.bytes.subarray(cursor * IPFS_MEDIA_BLOCK_BYTES, (cursor + 1) * IPFS_MEDIA_BLOCK_BYTES);
                  const cid = await blocks.put(block);
                  if (!alive() || cid !== manifest.blocks[cursor]) throw unavailable();
                  cursor++;
                }
                if (!alive()) throw unavailable();
                const grant = {manifest: JSON.stringify(manifest), key: new Uint8Array(sealed.key)};
                release("acknowledged");return grant;
              } catch {
                if (alive()) state = "unavailable";
                throw unavailable();
              } finally {running = false;}
            },
          });
        } catch (error) {sealed.bytes.fill(0);sealed.key.fill(0);throw error;}
      });
    },
    /** Keep verified ciphertext blocks for explicit download recovery, never partial plaintext. */
    prepareDownload(manifestJson: string, key: Uint8Array, binding: MediaBinding) {
      return run(async () => {
        const manifest = parseMediaBlockManifest(manifestJson);
        if (!(key instanceof Uint8Array) || key.length !== 32) throw unavailable();
        const bound = {tenant: binding?.tenant, object: binding?.object};
        const start = performance.now();
        if (!Number.isFinite(start)) throw unavailable();
        const rawKey = new Uint8Array(key), downloaded: Uint8Array[] = [];
        let lastTime = start, running = false, retained = true, verified = 0;
        let state: "ready" | "downloading" | "unavailable" | "verified" | "disposed" | "expired" = "ready";
        let timer: ReturnType<typeof setTimeout>;
        function release(next: typeof state) {
          if (!retained) return;
          retained = false; prepared = false; state = next;
          rawKey.fill(0); for (const bytes of downloaded) bytes.fill(0); downloaded.length = 0;
          clearTimeout(timer); signal.removeEventListener("abort", abort);
        }
        const abort = () => release("disposed");
        function alive() {
          if (!retained) return false;
          const now = performance.now();
          if (!Number.isFinite(now) || now < lastTime || now - start >= 15 * 60_000) {release("expired");return false;}
          lastTime = now;
          let allowed = false;
          try {allowed = !signal.aborted && current();} catch { /* no authority */ }
          if (!allowed) {release("disposed");return false;}
          return true;
        }
        prepared = true;
        timer = setTimeout(() => release("expired"), 15 * 60_000);
        signal.addEventListener("abort", abort, {once: true});
        if (!alive()) throw unavailable();
        return Object.freeze({
          status() {alive();return Object.freeze({state, verifiedBlocks: verified, totalBlocks: manifest.blocks.length});},
          dispose() {release("disposed");},
          async resume(): Promise<Uint8Array> {
            if (!alive() || running) throw unavailable();
            running = true; state = "downloading";
            let finalizing = false, returned = false, stored: Uint8Array | undefined, plaintext: Uint8Array | undefined;
            try {
              while (verified < manifest.blocks.length) {
                if (!alive()) throw unavailable();
                const size = Math.min(IPFS_MEDIA_BLOCK_BYTES, manifest.bytes - verified * IPFS_MEDIA_BLOCK_BYTES);
                const bytes = await blocks.get(manifest.blocks[verified], size);
                if (!alive() || !(bytes instanceof Uint8Array) || bytes.length !== size) throw unavailable();
                const copy = new Uint8Array(bytes); let saved = false;
                try {
                  if (await rawMediaBlockCid(copy) !== manifest.blocks[verified] || !alive()) throw unavailable();
                  downloaded.push(copy); verified++; saved = true;
                } finally {if (!saved) copy.fill(0);}
              }
              finalizing = true;
              stored = await assembleMediaBlocks(manifestJson, downloaded);
              if (!alive()) throw unavailable();
              plaintext = await openMedia(stored, manifest.sha256, rawKey, bound);
              if (!alive()) throw unavailable();
              release("verified"); returned = true; return plaintext;
            } catch {
              if (finalizing) release("disposed");
              else if (alive()) state = "unavailable";
              throw unavailable();
            } finally {
              stored?.fill(0); if (!returned) plaintext?.fill(0); running = false;
            }
          },
        });
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
            // Reject a bad block before spending bandwidth on any later blocks.
            const copy = new Uint8Array(bytes); let retained = false;
            try {
              if (await rawMediaBlockCid(copy) !== manifest.blocks[index]) throw unavailable();
              check(); downloaded.push(copy); retained = true;
            } finally {if (!retained) copy.fill(0);}
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
