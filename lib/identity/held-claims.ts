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

export const HELD_CLAIM_FAMILIES = [
  "ens",
  "unstoppable",
  "farcaster",
  "lens",
  "rss3",
] as const;

export type HeldClaimFamily = (typeof HELD_CLAIM_FAMILIES)[number];

export const HELD_CLAIM_PREFIX: Record<HeldClaimFamily, string> = {
  ens: "ens:",
  unstoppable: "unstoppable:",
  farcaster: "farcaster:",
  lens: "lens:",
  rss3: "rss3:",
};

/** `undefined` = lookup still in flight. `null` = settled empty. */
export type HeldLookupState = {
  [K in HeldClaimFamily]?: string | null;
};

export const SEE_GRANT_COPY =
  "Let another address see this. Revoke anytime.";

export function claimFamilyOf(claimId: string): HeldClaimFamily | null {
  const lower = claimId.trim().toLowerCase();
  for (const family of HELD_CLAIM_FAMILIES) {
    if (lower.startsWith(HELD_CLAIM_PREFIX[family])) return family;
  }
  return null;
}

export function claimLabelFromId(claimId: string): string {
  return claimId.replace(/^[a-z]+:/i, "");
}

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
    { id: walletClaimId(checksum), label: checksum },
  ];
  if (input.ens) options.push({ id: ensClaimId(input.ens), label: input.ens });
  if (input.unstoppable) {
    options.push({
      id: unstoppableClaimId(input.unstoppable),
      label: input.unstoppable,
    });
  }
  if (input.farcaster) {
    options.push({
      id: farcasterClaimId(input.farcaster),
      label: input.farcaster,
    });
  }
  if (input.lens) options.push({ id: lensClaimId(input.lens), label: input.lens });
  if (input.rss3) options.push({ id: rss3ClaimId(input.rss3), label: input.rss3 });
  return options;
}

/** Wallet plus already-linked overlay indicators. Source of truth is the Gun node. */
export function heldClaimOptionsFromIndicators(
  address: string,
  indicators: readonly string[],
): HeldClaimOption[] {
  let checksum: string;
  try {
    checksum = getAddress(address);
  } catch {
    return [];
  }
  const options: HeldClaimOption[] = [
    { id: walletClaimId(checksum), label: checksum },
  ];
  const seen = new Set<string>([checksum.toLowerCase()]);
  for (const raw of indicators) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ id, label: claimLabelFromId(id) });
  }
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
