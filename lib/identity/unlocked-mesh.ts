/**
 * Page memory for a SEA pair that IdentityBar has already unwrapped.
 * IndexedDB keeps wrapped keys wrapped. This module does not write the
 * private half back to disk or onto Gun.
 */

import { isSeaPubkey } from "@/lib/identity/forum-check";
import { isSeaPair, type SeaPair } from "@/lib/identity/sea";

type Listener = (address: string, pair: SeaPair | null) => void;

const pairs = new Map<string, SeaPair>();
const listeners = new Set<Listener>();

function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

function emit(address: string, pair: SeaPair | null): void {
  for (const listener of listeners) listener(address, pair);
}

/** Remember a pair after unlock, wrap, or a plaintext read. */
export function rememberUnlockedMeshPair(address: string, pair: SeaPair): void {
  const key = addressKey(address);
  if (!key || !isSeaPair(pair) || !isSeaPubkey(pair.pub)) return;
  pairs.set(key, pair);
  emit(key, pair);
}

/** Drop one address, or every address when sign-out clears the session. */
export function forgetUnlockedMeshPair(address?: string): void {
  if (address === undefined) {
    const keys = [...pairs.keys()];
    pairs.clear();
    for (const key of keys) emit(key, null);
    return;
  }
  const key = addressKey(address);
  if (!key || !pairs.has(key)) return;
  pairs.delete(key);
  emit(key, null);
}

export function readUnlockedMeshPair(address: string): SeaPair | null {
  return pairs.get(addressKey(address)) ?? null;
}

export function subscribeUnlockedMeshPair(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
