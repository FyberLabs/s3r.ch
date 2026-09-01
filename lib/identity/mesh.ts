import { createIndexedDbMeshKeyStore, isMeshKeyRecord, type MeshKeyRecord, type MeshKeyStore } from "./idb";
import { buildMeshLinkStatement } from "./mesh-link";
import { createSeaPair, type SeaPair } from "./sea";

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

/**
 * After a SIWE session is set: reuse this address's local SEA pair, or mint
 * one and ask the connected wallet to sign that the `pub` belongs to the
 * checksummed address. Persist pair + link in IndexedDB only.
 *
 * Never sessionStorage. Never `user.recall({ sessionStorage: true })`.
 * Never write the pair, SIWE signature, or this link onto the public Gun graph.
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
