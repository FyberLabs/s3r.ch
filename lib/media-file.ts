import { IPFS_RECORDING_TYPE } from "./ipfs-recording";
import { privateMediaTags } from "./media-tags";
/** Private file metadata is encrypted with its bytes, never public post metadata.
 * These helpers do not establish reader enrollment, Check, or current epoch state. */
import type { ItemReaderWrap, ItemWrapContext } from "sociacl-ids";
import { MEDIA_PLAIN_MAX, sealMedia, openMedia, type MediaBinding } from "./media-crypto";
import { openMediaForReader, sealMediaForReaders, type MediaReader } from "./media-reader-wraps";

export type MediaFileDescription = Readonly<{ name: string; mediaType: string; tags?:readonly string[] }>;
const types = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4", "video/mp4", "video/webm", "video/ogg", IPFS_RECORDING_TYPE]);
const magic = [0x73, 0x33, 0x66, 1];
const encoder = new TextEncoder();
const descriptorMax = 4096;
export function mediaFileDescription(value: unknown): MediaFileDescription {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid media description");
  const fields = Object.getOwnPropertyDescriptors(value);
  const hasTags=Object.hasOwn(fields,"tags");
  if (Reflect.ownKeys(fields).length !== (hasTags?3:2) || (hasTags&&!("value" in fields.tags)) || !fields.name || !fields.mediaType ||
      !("value" in fields.name) || !("value" in fields.mediaType)) throw Error("Invalid media description");
  const name = fields.name.value, mediaType = fields.mediaType.value;
  if (typeof name !== "string" || !name.length || name.length > 255 || name.trim() !== name || name === "." || name === ".." ||
      /[\/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) || !name.isWellFormed() ||
      encoder.encode(name).length > 255 || typeof mediaType !== "string" || !types.has(mediaType)) throw Error("Invalid media description");
  const tags=hasTags?privateMediaTags(fields.tags.value):[];
  if(tags.length&&!mediaType.startsWith("audio/"))throw Error("Tags are only supported for audio files");
  return Object.freeze({ name, mediaType, ...(tags.length?{tags}:{}) });
}
function encode(bytes: Uint8Array, input: MediaFileDescription): Uint8Array {
  const metadata = mediaFileDescription(input),version=metadata.tags?.length?2:1;
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MEDIA_PLAIN_MAX - 8) throw Error("Invalid media file size");
  const header = encoder.encode(JSON.stringify({ version, ...metadata, length: bytes.length }));
  if (header.length > descriptorMax || 8 + header.length + bytes.length > MEDIA_PLAIN_MAX) throw Error("Invalid media file size");
  const packed = new Uint8Array(8 + header.length + bytes.length);
  packed.set(magic);packed[3]=version; new DataView(packed.buffer).setUint32(4, header.length);
  packed.set(header, 8); packed.set(bytes, 8 + header.length);
  return packed;
}
function decode(packed: Uint8Array): Readonly<{ description: MediaFileDescription; bytes: Uint8Array }> {
  if (packed.length < 10 || magic.slice(0,3).some((value, i) => packed[i] !== value) || ![1,2].includes(packed[3])) throw Error("Invalid media file");
  const length = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(4);
  if (!length || length > (packed[3]===1?1024:descriptorMax) || 8 + length >= packed.length) throw Error("Invalid media file");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packed.subarray(8, 8 + length)));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== (packed[3]===1?"length,mediaType,name,version":"length,mediaType,name,tags,version") || value.version !== packed[3] ||
      !Number.isSafeInteger(value.length) || value.length !== packed.length - 8 - length) throw Error("Invalid media file");
  const metadata = mediaFileDescription({ name: value.name, mediaType: value.mediaType, ...(packed[3]===2?{tags:value.tags}:{}) });
  if(packed[3]===2&&(!metadata.tags?.length||JSON.stringify(metadata.tags)!==JSON.stringify(value.tags)))throw Error("Invalid media tags");
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

/** Prepare ciphertext before signing its digest into a grant. The caller must
 * keep the returned key private and clear it after publishing encrypted wraps. */
export async function prepareMediaFile(bytes: Uint8Array, metadata: MediaFileDescription, binding: MediaBinding) {
  const packed = encode(bytes, metadata);
  try { return await sealMedia(packed, binding); }
  finally { packed.fill(0); }
}


/** Caller must independently establish current item/group authority. */
export async function openMediaFileWithKey(stored:Uint8Array,sha256:string,key:Uint8Array,binding:MediaBinding){
  const packed=await openMedia(stored,sha256,key,binding);
  try{return decode(packed);}finally{packed.fill(0);}
}
