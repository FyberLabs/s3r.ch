/** Unmounted client integrity boundary. This neither authorizes nor transports bytes. */
import { MEDIA_STORED_MAX } from "./media-crypto";
export const IPFS_MEDIA_BLOCK_BYTES = 1024 * 1024;
export const IPFS_MEDIA_MANIFEST_BYTES = 16384;
export type MediaBlockManifest = Readonly<{
  version: 1; bytes: number; sha256: string; blocks: readonly string[];
}>;
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const invalid = () => new Error("Invalid IPFS media blocks");
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const digest = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
function base32(bytes: Uint8Array): string {
  let value = 0, bits = 0, result = "b";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function cidFromDigest(hash: Uint8Array): string {
  const bytes = new Uint8Array(36);
  bytes.set([1, 0x55, 0x12, 32]); bytes.set(hash, 4);
  return base32(bytes);
}
/** Canonical raw CIDv1/SHA-256 only, including header and zero base32 padding. */
export function isRawMediaBlockCid(value: unknown): value is string {
  if (typeof value !== "string" || !/^b[a-z2-7]{58}$/.test(value)) return false;
  const bytes = new Uint8Array(36); let acc = 0, bits = 0, offset = 0;
  for (const character of value.slice(1)) {
    acc = (acc << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) {bits -= 8; bytes[offset++] = (acc >>> bits) & 255;}
    acc &= (1 << bits) - 1;
  }
  return offset === 36 && acc === 0 && bytes[0] === 1 && bytes[1] === 0x55 && bytes[2] === 0x12 && bytes[3] === 32 && base32(bytes) === value;
}
function snapshot(bytes: Uint8Array, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (!(bytes instanceof Uint8Array) || bytes.length < min || bytes.length > max) throw invalid();
  return new Uint8Array(bytes);
}
/** Restricted raw-block CIDv1/SHA-256, not a UnixFS file CID or a gateway URL. */
export async function rawMediaBlockCid(block: Uint8Array): Promise<string> {
  return cidFromDigest(await digest(snapshot(block, 1, IPFS_MEDIA_BLOCK_BYTES)));
}
/** Parse bounded private metadata. Shape/integrity does NOT authenticate its author. */
export function parseMediaBlockManifest(json: string): MediaBlockManifest {
  if (typeof json !== "string" || json.length > IPFS_MEDIA_MANIFEST_BYTES || new TextEncoder().encode(json).length > IPFS_MEDIA_MANIFEST_BYTES) throw invalid();
  let value;
  try { value = JSON.parse(json); } catch { throw invalid(); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "blocks,bytes,sha256,version" ||
      value.version !== 1 || !Number.isSafeInteger(value.bytes) || value.bytes < 33 || value.bytes > MEDIA_STORED_MAX ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Array.isArray(value.blocks) ||
      value.blocks.length !== Math.ceil(value.bytes / IPFS_MEDIA_BLOCK_BYTES) || !value.blocks.every(isRawMediaBlockCid)) throw invalid();
  return Object.freeze({version: 1, bytes: value.bytes, sha256: value.sha256, blocks: Object.freeze([...value.blocks])});
}
function envelope(bytes: Uint8Array) {
  if (bytes[0] !== 0x73 || bytes[1] !== 0x33 || bytes[2] !== 0x6d || bytes[3] !== 1) throw invalid();
}
/** Call only with sealMedia output. The header check is not proof of encryption. */
export async function describeMediaBlocks(stored: Uint8Array): Promise<MediaBlockManifest> {
  const bytes = snapshot(stored, 33, MEDIA_STORED_MAX); envelope(bytes);
  const blocks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += IPFS_MEDIA_BLOCK_BYTES)
    blocks.push(await rawMediaBlockCid(bytes.subarray(offset, offset + IPFS_MEDIA_BLOCK_BYTES)));
  return Object.freeze({version: 1, bytes: bytes.length, sha256: hex(await digest(bytes)), blocks: Object.freeze(blocks)});
}
/** Caller supplies authenticated manifest JSON from the current private grant.
 * Returns ciphertext only. openMedia must verify binding/key/GCM before playback. */
export async function assembleMediaBlocks(manifestJson: string, supplied: readonly Uint8Array[]): Promise<Uint8Array> {
  const manifest = parseMediaBlockManifest(manifestJson);
  if (!Array.isArray(supplied) || supplied.length !== manifest.blocks.length) throw invalid();
  // Snapshot every block before the first await; bound allocation by the manifest.
  const bytes = new Uint8Array(manifest.bytes);
  for (let index = 0; index < supplied.length; index++) {
    const size = Math.min(IPFS_MEDIA_BLOCK_BYTES, manifest.bytes - index * IPFS_MEDIA_BLOCK_BYTES);
    const block = supplied[index];
    if (!(block instanceof Uint8Array) || block.length !== size) throw invalid();
    bytes.set(block, index * IPFS_MEDIA_BLOCK_BYTES);
  }
  for (let index = 0; index < manifest.blocks.length; index++) {
    const block = bytes.subarray(index * IPFS_MEDIA_BLOCK_BYTES, (index + 1) * IPFS_MEDIA_BLOCK_BYTES);
    if (await rawMediaBlockCid(block) !== manifest.blocks[index]) throw invalid();
  }
  if (hex(await digest(bytes)) !== manifest.sha256) throw invalid();
  envelope(bytes);
  return bytes;
}
