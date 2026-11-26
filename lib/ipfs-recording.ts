import { createKuboBlockClient } from "./ipfs-kubo-client";
import { IPFS_MEDIA_BLOCK_BYTES, parseMediaBlockManifest } from "./ipfs-media-blocks";
import { createIpfsMediaTransfer } from "./ipfs-media-transfer";
import type { MediaBinding } from "./media-crypto";
import { mediaPreviewKind } from "./media-preview";

export const IPFS_RECORDING_TYPE = "application/vnd.s3rch.ipfs-recording+json";
export const IPFS_RECORDING_MAX = 7 * IPFS_MEDIA_BLOCK_BYTES;
const descriptorMax = 4096;
const providerBudget = 8 * IPFS_MEDIA_BLOCK_BYTES;

type Options = {
  endpoint: string;
  binding: MediaBinding;
  signal: AbortSignal;
  transport: typeof fetch;
};

function recordingType(type: unknown): type is string {
  if (typeof type !== "string") return false;
  const kind = mediaPreviewKind(type);
  return kind === "audio" || kind === "video";
}

function provider(options: Options, maxBytes: number) {
  const current = () => !options.signal.aborted;
  const blocks = createKuboBlockClient({
    endpoint: options.endpoint, current, signal: options.signal, maxBytes,
    maxBytesPerMinute: providerBudget,
  }, options.transport);
  return createIpfsMediaTransfer({ blocks, current, signal: options.signal });
}

/** Called inside the authenticated private upload. Only this encrypted
 * descriptor is eligible for the existing server-side object grant. */
export async function uploadIpfsRecording(bytes: Uint8Array, mediaType: string, options: Options) {
  if (!recordingType(mediaType) || bytes.length < 1 || bytes.length > IPFS_RECORDING_MAX)
    throw Error("IPFS recording format or size is unavailable");
  const uploaded = await provider(options, providerBudget).upload(bytes, options.binding);
  try {
    options.signal.throwIfAborted();
    const descriptor = new TextEncoder().encode(JSON.stringify({
      version: 1, mediaType, manifest: uploaded.manifest, key: btoa(String.fromCharCode(...uploaded.key)),
    }));
    if (descriptor.length > descriptorMax) throw Error("IPFS recording descriptor is too large");
    return descriptor;
  } finally { uploaded.key.fill(0); }
}

/** The endpoint comes from the reader's explicit choice. A descriptor cannot
 * select a URL or send the reader's credentials to another origin. */
export async function openIpfsRecording(descriptor: Uint8Array, options: Options) {
  options.signal.throwIfAborted();
  if (!descriptor.length || descriptor.length > descriptorMax) throw Error("IPFS recording descriptor is invalid");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(descriptor));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 4 || !["key", "manifest", "mediaType", "version"].every(key => Object.hasOwn(value, key)) ||
      value.version !== 1 || !recordingType(value.mediaType) || typeof value.manifest !== "string" ||
      typeof value.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.key))
    throw Error("IPFS recording descriptor is invalid");
  const manifest = parseMediaBlockManifest(value.manifest);
  if (manifest.bytes > providerBudget) throw Error("IPFS recording is too large");
  const key = Uint8Array.from(atob(value.key), char => char.charCodeAt(0));
  try {
    if (key.length !== 32 || btoa(String.fromCharCode(...key)) !== value.key)
      throw Error("IPFS recording key is invalid");
    const bytes = await provider(options, manifest.bytes).download(value.manifest, key, options.binding);
    return { bytes, mediaType: value.mediaType };
  } finally { key.fill(0); }
}
