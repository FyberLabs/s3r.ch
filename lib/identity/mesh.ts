import {
  createIndexedDbMeshKeyStore,
  isMeshKeyRecord,
  isPlaintextMeshKeyRecord,
  isWrappedMeshKeyRecord,
  type MeshKeyRecord,
  type MeshKeyStore,
  type WrappedMeshKeyRecord,
} from "./idb";
import { buildMeshLinkStatement } from "./mesh-link";
import { createSeaPair, type SeaPair } from "./sea";
import { unwrapSeaPair, type PrfWrapEnvelope } from "./wrap";

export type EnsureLocalMeshKeyInput = {
  address: string;
  domain: string;
  uri: string;
  signMessage: (message: string) => Promise<string>;
  createPair?: () => Promise<SeaPair>;
  store?: MeshKeyStore;
};

export type EnsureLocalMeshKeyResult = {
  record: MeshKeyRecord;
  created: boolean;
};

export type ReadLocalMeshPairInput = {
  record: MeshKeyRecord;
  prfOutput?: Uint8Array;
  secondaryKey?: Uint8Array;
};

export type PersistWrappedMeshKeyInput = {
  address: string;
  envelope: PrfWrapEnvelope;
  store?: MeshKeyStore;
};

/**
 * After a SIWE session is set: reuse this address's local SEA pair, or mint
 * one and ask the connected wallet to sign that the `pub` belongs to the
 * checksummed address. Persist pair + link in IndexedDB only.
 *
 * Reuses plaintext or wrapped records. Does not mint again when wrapped.
 * Never sessionStorage. Never `user.recall({ sessionStorage: true })`.
 * Never write the pair, SIWE signature, envelope, or this link onto the
 * public Gun graph.
 */
export async function ensureLocalMeshKey(
  input: EnsureLocalMeshKeyInput,
): Promise<EnsureLocalMeshKeyResult> {
  const store = input.store ?? createIndexedDbMeshKeyStore();
  const existing = await store.get(input.address);
  if (existing && isMeshKeyRecord(existing)) {
    return { record: existing, created: false };
  }

  const pair = await (input.createPair ?? createSeaPair)();
  const signedPayload = buildMeshLinkStatement({
    domain: input.domain,
    uri: input.uri,
    address: input.address,
    seaPub: pair.pub,
  });
  const walletSignature = await input.signMessage(signedPayload);
  const record: MeshKeyRecord = {
    address: input.address,
    seaPub: pair.pub,
    seaPair: pair,
    walletSignature,
    signedPayload,
  };
  await store.put(record);
  const stored = await store.get(input.address);
  if (!stored) {
    throw new Error("Mesh key did not persist in IndexedDB.");
  }
  return { record: stored, created: true };
}

/** Read the SEA pair. Plaintext returns immediately; wrapped must unwrap. */
export async function readLocalMeshPair(input: ReadLocalMeshPairInput): Promise<SeaPair> {
  if (isPlaintextMeshKeyRecord(input.record)) {
    return input.record.seaPair;
  }
  if (!isWrappedMeshKeyRecord(input.record)) {
    throw new Error("Mesh key record is not readable.");
  }
  if (!input.prfOutput && !input.secondaryKey) {
    throw new Error("Wrapped mesh key needs a passkey PRF output or secondary key.");
  }
  return unwrapSeaPair({
    envelope: input.record.wrap,
    prfOutput: input.prfOutput,
    secondaryKey: input.secondaryKey,
    expectedAddress: input.record.address,
  });
}

/**
 * Replace a plaintext IndexedDB record with the wrap envelope.
 * Drops `seaPair` from disk. Rejects if the envelope does not bind this row.
 */
export async function persistWrappedMeshKey(
  input: PersistWrappedMeshKeyInput,
): Promise<WrappedMeshKeyRecord> {
  const store = input.store ?? createIndexedDbMeshKeyStore();
  const existing = await store.get(input.address);
  if (!existing || !isPlaintextMeshKeyRecord(existing)) {
    throw new Error("No plaintext mesh key to wrap.");
  }
  if (
    input.envelope.address !== existing.address ||
    input.envelope.seaPub !== existing.seaPub
  ) {
    throw new Error("Wrap envelope does not match this mesh key.");
  }
  const wrapped: WrappedMeshKeyRecord = {
    address: existing.address,
    seaPub: existing.seaPub,
    walletSignature: existing.walletSignature,
    signedPayload: existing.signedPayload,
    wrap: input.envelope,
  };
  await store.put(wrapped);
  const stored = await store.get(input.address);
  if (!stored || !isWrappedMeshKeyRecord(stored) || "seaPair" in stored) {
    throw new Error("Wrapped mesh key did not persist in IndexedDB.");
  }
  return stored;
}
