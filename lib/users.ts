/**
 * Gun-native user node. A user is a SociACL object on s3rch/users/<wallet>.
 * Held claims link by claim id (`ens:name.eth`). Default visibility is mine.
 * Share-into-mesh is a separate explicit put of the user node and/or
 * individual claims. Holding a claim is not publishing it.
 * Unshare is not this slice.
 */

import { getAddress } from "viem";
import {
  GUN_PROTOCOL_V,
  protocolVersionOf,
  type GunUserNode,
} from "./feed-types";
import {
  ensClaimId,
  farcasterClaimId,
  lensClaimId,
  rss3ClaimId,
  unstoppableClaimId,
  walletClaimId,
} from "./identity/held-claims";
import { admitUserNode, userSoul, type SeeAcl } from "./identity/check";

export type { GunUserNode };

export const USER_NODE_FORBIDDEN_KEYS = [
  "priv",
  "epriv",
  "signature",
  "siwe",
  "seaPair",
  "wrap",
  "paper",
  "dek",
  "kek",
  "walletSignature",
] as const;

export type User = {
  id: string;
  indicators: string[];
  provenance: string;
  ts: number;
  v?: number;
};

export type ComposeUserInput = {
  address: string;
  indicators?: string[];
  nowSeconds?: number;
};

export type HeldIndicatorInput = {
  ens?: string | null;
  unstoppable?: string | null;
  farcaster?: string | null;
  lens?: string | null;
  rss3?: string | null;
};

export type AdmitUserResult =
  | { user: User; object: string }
  | { denied: true };

export type ShareUserResult =
  | { node: GunUserNode; key: string }
  | { denied: true };

/** Claim ids linked on the user node. Wallet is the node id, not an indicator. */
export function namedHeldIndicators(input: HeldIndicatorInput): string[] {
  const raw: string[] = [];
  if (input.ens) raw.push(ensClaimId(input.ens));
  if (input.unstoppable) raw.push(unstoppableClaimId(input.unstoppable));
  if (input.farcaster) raw.push(farcasterClaimId(input.farcaster));
  if (input.lens) raw.push(lensClaimId(input.lens));
  if (input.rss3) raw.push(rss3ClaimId(input.rss3));
  return splitIndicators(raw);
}

/**
 * Split Gun-wire indicators. Preserve claim-id casing. Do not use
 * normalizeTags — that lowercases feed tags and would smash checksums.
 */
export function splitIndicators(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function joinIndicators(indicators: readonly string[]): string {
  return splitIndicators([...indicators]).join(",");
}

export function userNodeHasForbiddenSecrets(node: object): boolean {
  return USER_NODE_FORBIDDEN_KEYS.some((key) => key in node);
}

export function toGunUserNode(user: User): GunUserNode {
  return {
    id: user.id,
    indicators: joinIndicators(user.indicators),
    provenance: user.provenance,
    ts: user.ts,
    v: user.v ?? GUN_PROTOCOL_V,
  };
}

export function fromGunUserNode(
  node: (Partial<GunUserNode> & Record<string, unknown>) | null | undefined,
): User | null {
  if (!node || typeof node !== "object") return null;
  if (userNodeHasForbiddenSecrets(node)) return null;
  if (typeof node.id !== "string" || !node.id.trim()) return null;
  let id: string;
  try {
    id = getAddress(node.id);
  } catch {
    return null;
  }
  const v = protocolVersionOf(node.v);
  if (v === null) return null;
  return {
    id,
    indicators: splitIndicators(node.indicators),
    provenance: typeof node.provenance === "string" ? node.provenance.trim() : "",
    ts: typeof node.ts === "number" && Number.isFinite(node.ts) ? node.ts : 0,
    v,
  };
}

/**
 * Build a user node keyed by the checksummed wallet.
 * Indicators are verified held-claim ids. Empty indicators is valid
 * (published wallet identity, no shared claims yet).
 */
export function composeUser(input: ComposeUserInput): User | null {
  let id: string;
  try {
    id = getAddress(input.address);
  } catch {
    return null;
  }
  const ts =
    typeof input.nowSeconds === "number" && Number.isFinite(input.nowSeconds)
      ? Math.floor(input.nowSeconds)
      : Math.floor(Date.now() / 1000);
  return {
    id,
    indicators: splitIndicators(input.indicators ?? []),
    provenance: `s3rch:user:${id}`,
    ts,
    v: GUN_PROTOCOL_V,
  };
}

/** Dest re-auth before overlay register. Hint / URL fetch is not authorization. */
export function admitComposedUser(
  acl: SeeAcl,
  user: User,
  owner: string,
): AdmitUserResult {
  const admitted = admitUserNode(acl, toGunUserNode(user), owner);
  if ("denied" in admitted) return { denied: true };
  return { user, object: admitted.object };
}

function sharedIntersection(
  user: User,
  sharedIndicators: readonly string[],
): string[] {
  const held = new Set(user.indicators.map((row) => row.toLowerCase()));
  return splitIndicators([...sharedIndicators]).filter((row) =>
    held.has(row.toLowerCase()),
  );
}

/**
 * Prepare an explicit share of the user node onto s3rch/users/<wallet>.
 * Indicators on the public put are only those already marked shared.
 * Does not grant see. Does not dump the private footprint.
 */
export function prepareShareUserIntoMesh(
  acl: SeeAcl,
  user: User,
  owner: string,
  sharedIndicators: readonly string[] = [],
): ShareUserResult {
  const published = composeUser({
    address: user.id,
    indicators: sharedIntersection(user, sharedIndicators),
    nowSeconds: user.ts,
  });
  if (!published) return { denied: true };
  const admitted = admitComposedUser(acl, published, owner);
  if ("denied" in admitted) return { denied: true };
  return { node: toGunUserNode(published), key: published.id };
}

/**
 * Prepare an explicit share of one held claim onto the public user node.
 * Sharing the wallet claim publishes the user node without adding the
 * address to the indicators CSV (the id is the wallet).
 * A claim that is not on the overlay node is denied.
 */
export function prepareShareClaimIntoMesh(
  acl: SeeAcl,
  user: User,
  owner: string,
  claimId: string,
  alreadyShared: readonly string[] = [],
  nowSeconds?: number,
): ShareUserResult {
  const claim = claimId.trim();
  if (!claim) return { denied: true };

  let walletClaim = false;
  try {
    walletClaim = getAddress(claim) === getAddress(user.id);
  } catch {
    walletClaim = false;
  }

  if (!walletClaim) {
    const held = user.indicators.some(
      (row) => row.toLowerCase() === claim.toLowerCase(),
    );
    if (!held) return { denied: true };
  }

  const nextShared = walletClaim
    ? alreadyShared
    : [...alreadyShared, claim];
  const published = composeUser({
    address: user.id,
    indicators: sharedIntersection(user, nextShared),
    nowSeconds:
      typeof nowSeconds === "number" && Number.isFinite(nowSeconds)
        ? Math.floor(nowSeconds)
        : user.ts,
  });
  if (!published) return { denied: true };
  const admitted = admitComposedUser(acl, published, owner);
  if ("denied" in admitted) return { denied: true };
  return { node: toGunUserNode(published), key: published.id };
}

export function ownsUser(
  user: Pick<User, "id">,
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  try {
    return getAddress(user.id) === getAddress(address);
  } catch {
    return false;
  }
}

export function isWalletClaimId(claimId: string, wallet: string): boolean {
  try {
    return getAddress(claimId) === getAddress(wallet);
  } catch {
    return false;
  }
}

export function claimIsShared(
  claimId: string,
  sharedIndicators: readonly string[],
): boolean {
  const needle = claimId.trim().toLowerCase();
  if (!needle) return false;
  return sharedIndicators.some((row) => row.trim().toLowerCase() === needle);
}

/** Prefer newer ts so a later claim-share HAM-wins over an empty publish. */
export function mergeUsers(
  seed: readonly User[],
  overlay: readonly User[] = [],
): User[] {
  const byId = new Map<string, User>();
  for (const user of [...seed, ...overlay]) {
    if (!user.id) continue;
    const existing = byId.get(user.id);
    if (!existing || (user.ts || 0) >= (existing.ts || 0)) {
      byId.set(user.id, user);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id),
  );
}

/** Discovery-friendly provenance. Truncated address + shared indicators. */
export function userProvenanceLine(user: Pick<User, "id" | "indicators">): string {
  const who = shortenWallet(user.id);
  if (user.indicators.length === 0) return who;
  return `${who} · ${user.indicators.join(", ")}`;
}

export function shortenWallet(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function userObjectSoul(wallet: string): string {
  return userSoul(wallet);
}

export { walletClaimId };
