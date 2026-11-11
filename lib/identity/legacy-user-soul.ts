/** Legacy wallet-keyed feed storage; canonical identities use SEA principals. */
import { getAddress } from "viem";

/** s3rch/users/<wallet> — checksum when the key is an address. */
export function legacyUserSoul(wallet: string): string {
  const trimmed = wallet.trim();
  try {
    return `s3rch/users/${getAddress(trimmed)}`;
  } catch {
    return `s3rch/users/${trimmed}`;
  }
}

