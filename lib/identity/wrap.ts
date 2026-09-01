/**
 * WebAuthn PRF wrap of the local Gun SEA pair.
 *
 * Recovery / device proof — not login. Session subject stays the checksummed
 * Ethereum address.
 *
 * - Random DEK encrypts the SEA pair JSON (AES-256-GCM).
 * - DEK is wrapped by ≥2 KEKs: PRF-derived and secondary (wallet or paper).
 * - KEKs are HKDF-SHA-256 of the IKM with info exactly
 *   `s3r.ch/sea-wrap/aes-gcm/v1`. Never use raw PRF bytes as the AES key.
 * - Envelope lives in origin IndexedDB only. Never write the envelope, DEK,
 *   KEKs, SIWE signatures, or SEA `priv` / `epriv` to the public Gun graph.
 * - Native WebAuthn only (see webauthn-prf.ts). No SimpleWebAuthn.
 */

import { getAddress, hexToBytes } from "viem";
import { SECONDARY_WRAP_STATEMENT } from "./config";
import { assertMeshLinkBinding } from "./mesh-link";
import { isSeaPair, type SeaPair } from "./sea";
import { hostnameOf } from "./siwe";

export type WrapKekKind = "prf" | "secondary";

export type SeaWrapRpId = "s3r.ch" | "localhost" | "127.0.0.1";

export type SeaWrapSecondaryKind = "wallet" | "paper";

export const SEA_WRAP_VERSION = 1;
export const SEA_WRAP_HKDF_INFO = "s3r.ch/sea-wrap/aes-gcm/v1";
export const SEA_WRAP_CONTENT_ALG = "AES-256-GCM";
export const SEA_WRAP_WRAP_ALG = "HKDF-SHA-256+AES-256-GCM";
export const PAPER_BACKUP_PREFIX = "s3rch-wrap-v1:";

export const SEA_WRAP_ALG = {
  wrap: SEA_WRAP_WRAP_ALG,
  content: SEA_WRAP_CONTENT_ALG,
  hkdfInfo: SEA_WRAP_HKDF_INFO,
} as const;

const DEK_BYTES = 32;
const IV_BYTES = 12;
const MIN_IKM_BYTES = 16;
const MIN_SALT_BYTES = 16;
const HKDF_INFO_BYTES = new TextEncoder().encode(SEA_WRAP_HKDF_INFO);
const ALLOWED_RP_IDS = new Set<SeaWrapRpId>(["s3r.ch", "localhost", "127.0.0.1"]);

export type PrfWrapEnvelope = {
  version: 1;
  rpId: SeaWrapRpId;
  address: string;
  seaPub: string;
  credentialId: string;
  prfSalt: string;
  secondarySalt?: string;
  secondaryKind?: SeaWrapSecondaryKind;
  dekWrappedByPrfKek: string;
  dekWrappedBySecondaryKek: string;
  ciphertext: string;
  alg: {
    wrap: typeof SEA_WRAP_WRAP_ALG;
    content: typeof SEA_WRAP_CONTENT_ALG;
    hkdfInfo: typeof SEA_WRAP_HKDF_INFO;
  };
};

export type WrapDekInput = {
  dek: Uint8Array;
  prfOutput: Uint8Array;
  secondaryKey: Uint8Array;
  address: string;
};

export type UnwrapDekInput = {
  dekWrappedByPrfKek: string;
  dekWrappedBySecondaryKek: string;
  address: string;
  prfOutput?: Uint8Array;
  secondaryKey?: Uint8Array;
};

export type WrapSeaPairInput = {
  pair: SeaPair;
  address: string;
  rpId: SeaWrapRpId;
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  prfOutput: Uint8Array;
  secondaryKey: Uint8Array;
  secondarySalt?: Uint8Array;
  secondaryKind?: SeaWrapSecondaryKind;
};

export type UnwrapSeaPairInput = {
  envelope: PrfWrapEnvelope;
  prfOutput?: Uint8Array;
  secondaryKey?: Uint8Array;
  expectedAddress?: string;
};

export function resolveRpId(host: string): SeaWrapRpId {
  const hostname = hostnameOf(host);
  if (hostname === "s3r.ch") return "s3r.ch";
  if (hostname === "localhost") return "localhost";
  if (hostname === "127.0.0.1") return "127.0.0.1";
  throw new Error("WebAuthn rp.id is not allowed for this host.");
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return globalThis.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = globalThis.atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodePaperBackup(secondaryKey: Uint8Array): string {
  assertIkm(secondaryKey, "Paper backup");
  return `${PAPER_BACKUP_PREFIX}${bytesToBase64Url(secondaryKey)}`;
}

export function decodePaperBackup(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed.startsWith(PAPER_BACKUP_PREFIX)) {
    throw new Error("Paper backup is not a s3r.ch wrap v1 string.");
  }
  const bytes = base64UrlToBytes(trimmed.slice(PAPER_BACKUP_PREFIX.length));
  assertIkm(bytes, "Paper backup");
  return bytes;
}

export function buildSecondaryWrapStatement(input: {
  domain: string;
  uri: string;
  address: string;
  secondarySalt: Uint8Array;
}): string {
  const binding = assertMeshLinkBinding(input);
  if (input.secondarySalt.byteLength < MIN_SALT_BYTES) {
    throw new Error("Secondary salt is too short.");
  }
  return [
    SECONDARY_WRAP_STATEMENT,
    `Domain: ${binding.domain}`,
    `URI: ${binding.uri}`,
    `Address: ${binding.address}`,
    `Secondary salt: ${bytesToBase64Url(input.secondarySalt)}`,
  ].join("\n");
}

export function secondaryIkmFromWalletSignature(signature: string): Uint8Array {
  const trimmed = signature.trim();
  if (!trimmed) throw new Error("Secondary wallet signature is empty.");
  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Secondary wallet signature is not hex.");
  }
  const bytes = hexToBytes(hex as `0x${string}`);
  assertIkm(bytes, "Secondary wallet signature");
  return bytes;
}

export function isPrfWrapEnvelope(value: unknown): value is PrfWrapEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== SEA_WRAP_VERSION) return false;
  if (!isSeaWrapRpId(envelope.rpId)) return false;
  if (typeof envelope.address !== "string") return false;
  try {
    if (getAddress(envelope.address) !== envelope.address) return false;
  } catch {
    return false;
  }
  if (typeof envelope.seaPub !== "string" || envelope.seaPub.length === 0) return false;
  if (!isBase64UrlBlob(envelope.credentialId, 1)) return false;
  if (!isBase64UrlBlob(envelope.prfSalt, MIN_SALT_BYTES)) return false;
  if (envelope.secondarySalt != null && !isBase64UrlBlob(envelope.secondarySalt, MIN_SALT_BYTES)) {
    return false;
  }
  if (envelope.secondaryKind != null && !isSecondaryKind(envelope.secondaryKind)) return false;
  if (!isAesGcmBlob(envelope.dekWrappedByPrfKek)) return false;
  if (!isAesGcmBlob(envelope.dekWrappedBySecondaryKek)) return false;
  if (!isAesGcmBlob(envelope.ciphertext)) return false;
  const alg = envelope.alg;
  if (!alg || typeof alg !== "object") return false;
  const ids = alg as Record<string, unknown>;
  return (
    ids.wrap === SEA_WRAP_WRAP_ALG &&
    ids.content === SEA_WRAP_CONTENT_ALG &&
    ids.hkdfInfo === SEA_WRAP_HKDF_INFO
  );
}

export async function wrapDek(params: WrapDekInput): Promise<{
  dekWrappedByPrfKek: string;
  dekWrappedBySecondaryKek: string;
}> {
  const address = checksumAddress(params.address);
  assertDek(params.dek);
  const prfKey = await deriveAesGcmKey(params.prfOutput);
  const secondaryKey = await deriveAesGcmKey(params.secondaryKey);
  const dekWrappedByPrfKek = await encryptAesGcm(
    prfKey,
    params.dek,
    dekWrapAad("prf", address),
  );
  const dekWrappedBySecondaryKek = await encryptAesGcm(
    secondaryKey,
    params.dek,
    dekWrapAad("secondary", address),
  );
  return { dekWrappedByPrfKek, dekWrappedBySecondaryKek };
}

export async function unwrapDek(params: UnwrapDekInput): Promise<Uint8Array> {
  const address = checksumAddress(params.address);
  if (!params.prfOutput && !params.secondaryKey) {
    throw new Error("A PRF output or secondary key is required to unwrap the DEK.");
  }
  if (params.prfOutput) {
    try {
      return await decryptAesGcm(
        await deriveAesGcmKey(params.prfOutput),
        params.dekWrappedByPrfKek,
        dekWrapAad("prf", address),
        DEK_BYTES,
      );
    } catch (error) {
      if (!params.secondaryKey) throw unwrapFailure("PRF", error);
    }
  }
  if (params.secondaryKey) {
    try {
      return await decryptAesGcm(
        await deriveAesGcmKey(params.secondaryKey),
        params.dekWrappedBySecondaryKek,
        dekWrapAad("secondary", address),
        DEK_BYTES,
      );
    } catch (error) {
      throw unwrapFailure("secondary", error);
    }
  }
  throw new Error("Could not unwrap the DEK.");
}

export async function wrapSeaPair(params: WrapSeaPairInput): Promise<PrfWrapEnvelope> {
  if (!isSeaPair(params.pair)) {
    throw new Error("SEA pair is incomplete.");
  }
  if (!ALLOWED_RP_IDS.has(params.rpId)) {
    throw new Error("WebAuthn rp.id is not allowed.");
  }
  if (params.credentialId.byteLength < 1) {
    throw new Error("Passkey credential id is missing.");
  }
  if (params.prfSalt.byteLength < MIN_SALT_BYTES) {
    throw new Error("PRF salt is too short.");
  }
  if (params.secondarySalt && params.secondarySalt.byteLength < MIN_SALT_BYTES) {
    throw new Error("Secondary salt is too short.");
  }

  const address = checksumAddress(params.address);
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const dekKey = await importAesGcmKey(dek);
  const plaintext = new TextEncoder().encode(JSON.stringify(canonicalSeaPair(params.pair)));
  const ciphertext = await encryptAesGcm(dekKey, plaintext, contentAad(address, params.pair.pub));
  const wrapped = await wrapDek({
    dek,
    prfOutput: params.prfOutput,
    secondaryKey: params.secondaryKey,
    address,
  });

  dek.fill(0);

  const envelope: PrfWrapEnvelope = {
    version: 1,
    rpId: params.rpId,
    address,
    seaPub: params.pair.pub,
    credentialId: bytesToBase64Url(params.credentialId),
    prfSalt: bytesToBase64Url(params.prfSalt),
    dekWrappedByPrfKek: wrapped.dekWrappedByPrfKek,
    dekWrappedBySecondaryKek: wrapped.dekWrappedBySecondaryKek,
    ciphertext,
    alg: { ...SEA_WRAP_ALG },
  };
  if (params.secondarySalt) {
    envelope.secondarySalt = bytesToBase64Url(params.secondarySalt);
  }
  if (params.secondaryKind) {
    envelope.secondaryKind = params.secondaryKind;
  }
  return envelope;
}

export async function unwrapSeaPair(params: UnwrapSeaPairInput): Promise<SeaPair> {
  if (!isPrfWrapEnvelope(params.envelope)) {
    throw new Error("Wrap envelope is incomplete.");
  }
  if (params.expectedAddress) {
    const expected = checksumAddress(params.expectedAddress);
    if (params.envelope.address !== expected) {
      throw new Error("Wrap envelope is bound to a different address.");
    }
  }
  const dek = await unwrapDek({
    dekWrappedByPrfKek: params.envelope.dekWrappedByPrfKek,
    dekWrappedBySecondaryKek: params.envelope.dekWrappedBySecondaryKek,
    address: params.envelope.address,
    prfOutput: params.prfOutput,
    secondaryKey: params.secondaryKey,
  });
  const dekKey = await importAesGcmKey(dek);
  dek.fill(0);
  const plaintext = await decryptAesGcm(
    dekKey,
    params.envelope.ciphertext,
    contentAad(params.envelope.address, params.envelope.seaPub),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Unwrapped SEA pair is not valid JSON.");
  }
  if (!isSeaPair(parsed) || parsed.pub !== params.envelope.seaPub) {
    throw new Error("Unwrapped SEA pair does not match the envelope.");
  }
  return canonicalSeaPair(parsed);
}

function canonicalSeaPair(pair: SeaPair): SeaPair {
  return {
    pub: pair.pub,
    priv: pair.priv,
    epub: pair.epub,
    epriv: pair.epriv,
  };
}

function checksumAddress(address: string): string {
  return getAddress(address);
}

function isSeaWrapRpId(value: unknown): value is SeaWrapRpId {
  return value === "s3r.ch" || value === "localhost" || value === "127.0.0.1";
}

function isSecondaryKind(value: unknown): value is SeaWrapSecondaryKind {
  return value === "wallet" || value === "paper";
}

function isBase64UrlBlob(value: unknown, minBytes: number): value is string {
  if (typeof value !== "string") return false;
  try {
    return base64UrlToBytes(value).byteLength >= minBytes;
  } catch {
    return false;
  }
}

function isAesGcmBlob(value: unknown): value is string {
  return isBase64UrlBlob(value, IV_BYTES + 16);
}

function assertDek(dek: Uint8Array): void {
  if (dek.byteLength !== DEK_BYTES) {
    throw new Error("DEK must be 32 bytes.");
  }
}

function assertIkm(ikm: Uint8Array, label: string): void {
  if (ikm.byteLength < MIN_IKM_BYTES) {
    throw new Error(`${label} is too short.`);
  }
}

function dekWrapAad(kind: WrapKekKind, address: string): Uint8Array {
  return new TextEncoder().encode(`s3r.ch/sea-wrap/dek/${kind}/v1\n${address}`);
}

function contentAad(address: string, seaPub: string): Uint8Array {
  return new TextEncoder().encode(`${address}\n${seaPub}\nv1`);
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function deriveAesGcmKey(ikm: Uint8Array): Promise<CryptoKey> {
  assertIkm(ikm, "Wrap IKM");
  const baseKey = await crypto.subtle.importKey(
    "raw",
    copyBytes(ikm),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: copyBytes(HKDF_INFO_BYTES),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", copyBytes(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptAesGcm(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: copyBytes(aad) },
      key,
      copyBytes(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.byteLength);
  return bytesToBase64Url(packed);
}

async function decryptAesGcm(
  key: CryptoKey,
  blob: string,
  aad: Uint8Array,
  expectedLength?: number,
): Promise<Uint8Array> {
  const packed = base64UrlToBytes(blob);
  if (packed.byteLength < IV_BYTES + 16) {
    throw new Error("AES-GCM blob is too short.");
  }
  const iv = packed.subarray(0, IV_BYTES);
  const ciphertext = packed.subarray(IV_BYTES);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: copyBytes(iv), additionalData: copyBytes(aad) },
      key,
      copyBytes(ciphertext),
    ),
  );
  if (expectedLength != null && plaintext.byteLength !== expectedLength) {
    throw new Error("Unwrapped DEK has the wrong length.");
  }
  return plaintext;
}

function unwrapFailure(kind: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : "decrypt failed";
  return new Error(`Could not unwrap the DEK with the ${kind} KEK (${detail}).`);
}
