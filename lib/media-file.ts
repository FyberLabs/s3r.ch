/** Private file metadata is encrypted with its bytes, never public post metadata.
 * These helpers do not establish reader enrollment, Check, or current epoch state. */
import type { ItemReaderWrap, ItemWrapContext } from "sociacl-ids";
import { MEDIA_PLAIN_MAX, type MediaBinding } from "./media-crypto";
import { openMediaForReader, sealMediaForReaders, type MediaReader } from "./media-reader-wraps";

export type MediaFileDescription = Readonly<{ name: string; mediaType: string }>;
const types = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4", "video/mp4", "video/webm", "video/ogg"]);
const magic = [0x73, 0x33, 0x66, 1];
const encoder = new TextEncoder();
const descriptorMax = 1024;
function description(value: unknown): MediaFileDescription {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid media description");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 2 || !fields.name || !fields.mediaType ||
      !("value" in fields.name) || !("value" in fields.mediaType)) throw Error("Invalid media description");
  const name = fields.name.value, mediaType = fields.mediaType.value;
  if (typeof name !== "string" || !name.length || name.length > 255 || name.trim() !== name || name === "." || name === ".." ||
      /[\/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) || !name.isWellFormed() ||
      encoder.encode(name).length > 255 || typeof mediaType !== "string" || !types.has(mediaType)) throw Error("Invalid media description");
  return Object.freeze({ name, mediaType });
}
function encode(bytes: Uint8Array, input: MediaFileDescription): Uint8Array {
  const metadata = description(input);
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MEDIA_PLAIN_MAX - 8) throw Error("Invalid media file size");
  const header = encoder.encode(JSON.stringify({ version: 1, ...metadata, length: bytes.length }));
  if (header.length > descriptorMax || 8 + header.length + bytes.length > MEDIA_PLAIN_MAX) throw Error("Invalid media file size");
  const packed = new Uint8Array(8 + header.length + bytes.length);
  packed.set(magic); new DataView(packed.buffer).setUint32(4, header.length);
  packed.set(header, 8); packed.set(bytes, 8 + header.length);
  return packed;
}
function decode(packed: Uint8Array): Readonly<{ description: MediaFileDescription; bytes: Uint8Array }> {
  if (packed.length < 10 || magic.some((value, i) => packed[i] !== value)) throw Error("Invalid media file");
  const length = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(4);
  if (!length || length > descriptorMax || 8 + length >= packed.length) throw Error("Invalid media file");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packed.subarray(8, 8 + length)));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "length,mediaType,name,version" || value.version !== 1 ||
      !Number.isSafeInteger(value.length) || value.length !== packed.length - 8 - length) throw Error("Invalid media file");
  const metadata = description({ name: value.name, mediaType: value.mediaType });
  return Object.freeze({ description: metadata, bytes: packed.slice(8 + length) });
}

/** Call only with independently authorized current readers and grant context.
 * File type is a label, not a content inspection or a guarantee of safe decoding. */
export async function sealMediaFile(bytes: Uint8Array, metadata: MediaFileDescription, binding: MediaBinding,
  expected: ItemWrapContext, readers: readonly MediaReader[], named: readonly string[]) {
  const packed = encode(bytes, metadata);
  try { return await sealMediaForReaders(packed, binding, expected, readers, named); }
  finally { packed.fill(0); }
}
export async function openMediaFile(stored: Uint8Array, sha256: string, wrap: ItemReaderWrap,
  epriv: string, epub: string, binding: MediaBinding, expected: ItemWrapContext) {
  const packed = await openMediaForReader(stored, sha256, wrap, epriv, epub, binding, expected);
  try { return decode(packed); }
  finally { packed.fill(0); }
}
