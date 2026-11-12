import { signForumRecord, readForumSignature } from "../forum-sign";
import { findMeshKeyBySea, getMeshKey, isPlaintextMeshKeyRecord, type MeshKeyRecord } from "./idb";
import { readUnlockedMeshPair, readUnlockedMeshRevision, rememberUnlockedMeshPair } from "./unlocked-mesh";
import type { SeaPair } from "./sea";

type Sources = {
  find(pub: string): Promise<MeshKeyRecord | null>; read(address: string): Promise<MeshKeyRecord | null>;
  prove(pair: SeaPair): Promise<boolean>;
  unlocked(address: string): SeaPair | null; revision(): number; remember(address: string, pair: SeaPair): void;
};
const sources: Sources = { find: findMeshKeyBySea, read: getMeshKey, unlocked: readUnlockedMeshPair,
  revision: readUnlockedMeshRevision, remember: rememberUnlockedMeshPair,
  prove: proveStartupKey };

export async function proveStartupKey(pair: SeaPair): Promise<boolean> {
  try {
    const challenge = "s3rch-local-startup-key:" + crypto.randomUUID();
    const signature = await signForumRecord(challenge, pair);
    return !!signature && await readForumSignature(signature, pair.pub) === challenge;
  } catch { return false; }
}

/** Existing storage only. A linked wallet can locate a key but never replace
 * the configured SEA identity. Wrapped keys stay wrapped until the user unlocks.
 */
export async function loadStartupExistingKey(pub: string, selectedAddress: string | null, source: Sources = sources):
  Promise<{ state: "ready"; address: string } | { state: "missing" | "locked" | "conflict" }> {
  const revision = source.revision();
  try {
    const record = selectedAddress ? await source.read(selectedAddress) : await source.find(pub);
    if (source.revision() !== revision) return { state: "locked" };
    if (!record) return { state: "missing" };
    if (record.seaPub !== pub) return { state: "conflict" };
    const held = source.unlocked(record.address);
    if (held && held.pub !== pub) return { state: "conflict" };
    const pair = held ?? (isPlaintextMeshKeyRecord(record) ? record.seaPair : null);
    if (!pair) return { state: "locked" };
    if (!await source.prove(pair)) return { state: "conflict" };
    if (source.revision() !== revision) return { state: "locked" };
    if (!held) source.remember(record.address, pair);
    return source.unlocked(record.address) === pair && pair.pub === pub ?
      { state: "ready", address: record.address } : { state: "locked" };
  } catch { return { state: "missing" }; }
}
