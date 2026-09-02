/**
 * Held-claim ids linked from the user node.
 *
 * Claim object id is the claim id (e.g. `ens:vitalik.eth`).
 * Do not invent `s3rch/users/{wallet}/claims/…`.
 */

import { getAddress } from "viem";

export type HeldClaimOption = {
  id: string;
  label: string;
};

export const SEE_GRANT_COPY = "This is a grant, not login.";

export function ensClaimId(name: string): string {
  return `ens:${name.trim()}`;
}

export function unstoppableClaimId(name: string): string {
  return `unstoppable:${name.trim()}`;
}

export function farcasterClaimId(name: string): string {
  return `farcaster:${name.trim()}`;
}

export function lensClaimId(name: string): string {
  return `lens:${name.trim()}`;
}

export function rss3ClaimId(name: string): string {
  return `rss3:${name.trim()}`;
}

export function walletClaimId(address: string): string {
  return getAddress(address);
}

export function heldClaimOptions(input: {
  address: string;
  ens?: string | null;
  unstoppable?: string | null;
  farcaster?: string | null;
  lens?: string | null;
  rss3?: string | null;
}): HeldClaimOption[] {
  let checksum: string;
  try {
    checksum = getAddress(input.address);
  } catch {
    return [];
  }
  const options: HeldClaimOption[] = [
    { id: walletClaimId(checksum), label: `wallet ${checksum}` },
  ];
  if (input.ens) options.push({ id: ensClaimId(input.ens), label: `ENS ${input.ens}` });
  if (input.unstoppable) {
    options.push({
      id: unstoppableClaimId(input.unstoppable),
      label: `Unstoppable ${input.unstoppable}`,
    });
  }
  if (input.farcaster) {
    options.push({
      id: farcasterClaimId(input.farcaster),
      label: `Farcaster ${input.farcaster}`,
    });
  }
  if (input.lens) options.push({ id: lensClaimId(input.lens), label: `Lens ${input.lens}` });
  if (input.rss3) options.push({ id: rss3ClaimId(input.rss3), label: `RSS3 ${input.rss3}` });
  return options;
}

export function parseGrantAccessor(value: string): string | null {
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

export function grantWindowFromHours(
  hours: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): { from: number; until: number } | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const seconds = Math.floor(hours * 60 * 60);
  if (seconds <= 0) return null;
  return { from: nowSeconds, until: nowSeconds + seconds };
}
