/** Browser-side opaque media envelope for the Spanopticon tenant object API.
 * This is encryption, not authorization. Keep keys in the encrypted owner/grant
 * material; never place them in public metadata, URLs or storage requests. */
import { isCanonicalObjectId } from "./identity/object-id";

export const MEDIA_STORED_MAX = 64 * 1024 * 1024;
const HEADER = new Uint8Array([0x73, 0x33, 0x6d, 1]);
const OVERHEAD = HEADER.length + 12 + 16;
export const MEDIA_PLAIN_MAX = MEDIA_STORED_MAX - OVERHEAD;
export type MediaBinding = Readonly<{ tenant: string; object: string }>;
export type SealedMedia = { bytes: Uint8Array; sha256: string; key: Uint8Array };
const encoder = new TextEncoder();

function aad(binding: MediaBinding): Uint8Array<ArrayBuffer> {
  if (!binding || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(binding.tenant) ||
      binding.tenant === "00000000-0000-0000-0000-000000000000" || !isCanonicalObjectId(binding.object))
    throw new Error("Invalid media binding");
  return encoder.encode(JSON.stringify(["s3rch-media-v1", binding.tenant, binding.object]));
}
function copy(bytes: Uint8Array, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < min || bytes.byteLength > max)
    throw new Error("Invalid media size");
  // Snapshot caller-owned arrays before any asynchronous operation.
  return new Uint8Array(bytes);
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

/** Each call makes a fresh 256-bit key and 96-bit nonce. Retry storage with the
 * returned bytes and digest, rather than encrypting again under a reused key. */
export async function sealMedia(plaintext: Uint8Array, binding: MediaBinding): Promise<SealedMedia> {
  const data = copy(plaintext, 1, MEDIA_PLAIN_MAX), additionalData = aad(binding);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, imported, data));
  const bytes = new Uint8Array(HEADER.length + iv.length + ciphertext.length);
  bytes.set(HEADER); bytes.set(iv, HEADER.length); bytes.set(ciphertext, HEADER.length + iv.length);
  return { bytes, sha256: await digest(bytes), key };
}

/** No plaintext is returned until address, envelope, binding and GCM tag verify.
 * The caller must obtain both binding and key through its current Check grant. */
export async function openMedia(stored: Uint8Array, sha256: string, key: Uint8Array, binding: MediaBinding): Promise<Uint8Array> {
  const bytes = copy(stored, OVERHEAD + 1, MEDIA_STORED_MAX), rawKey = copy(key, 32, 32), additionalData = aad(binding);
  if (!/^[0-9a-f]{64}$/.test(sha256) || HEADER.some((value, i) => bytes[i] !== value) || await digest(bytes) !== sha256)
    throw new Error("Invalid media envelope");
  const imported = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(4, 16), additionalData, tagLength: 128 }, imported, bytes.slice(16)));
}
