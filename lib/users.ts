/**
 * Gun-native user node. A user is a SociACL object on s3rch/users/<wallet>.
 * Held claims link by claim id (`ens:name.eth`). Default visibility is mine.
 * Share-into-mesh is a separate explicit put of the user node and/or
 * individual claims. Holding a claim is not publishing it.
 * Unshare retracts the user node (tombstone) or republishes without one claim.
 */

import { getAddress } from "viem";
import {
  GUN_PROTOCOL_V,
  isUnsharePut,
  protocolVersionOf,
  type GunUserNode,
} from "./feed-types";
import {
  dropById,
  userUnshareTombstone,
  type UnshareResult,
} from "./unshare";
import {
  HELD_CLAIM_FAMILIES,
  HELD_CLAIM_PREFIX,
  ensClaimId,
  emailClaimId,
  farcasterClaimId,
  kycClaimId,
  lensClaimId,
  normalizeEmailTarget,
  normalizePhoneTarget,
  parseKycLookup,
  phoneClaimId,
  rss3ClaimId,
  unstoppableClaimId,
  walletClaimId,
  type HeldLookupState,
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
  email?: string | null;
  phone?: string | null;
  kyc?: string | null;
};

export type AssembleMineUserInput = {
  address: string;
  lookups?: HeldLookupState;
  indicators?: readonly string[];
  previous?: User | null;
  nowSeconds?: number;
};

export type RegisterMineUserResult =
  | { user: User; object: string; node: GunUserNode }
  | { denied: true };

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
  if (input.email && normalizeEmailTarget(input.email)) {
    raw.push(emailClaimId(input.email));
  }
  if (input.phone && normalizePhoneTarget(input.phone)) {
    raw.push(phoneClaimId(input.phone));
  }
  if (input.kyc) {
    const parsed = parseKycLookup(input.kyc);
    if (parsed) raw.push(kycClaimId(parsed.issuer, parsed.subject));
  }
  return splitIndicators(raw);
}

export function sameHeldIndicators(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = splitIndicators([...left]);
  const b = splitIndicators([...right]);
  if (a.length !== b.length) return false;
  return a.every((row, index) => row.toLowerCase() === b[index]?.toLowerCase());
}

/**
 * Link verified held-claim ids onto the Mine overlay.
 * `undefined` lookup = still in flight — keep that family from `previous`.
 * `null` = settled empty — drop that family. Does not publish.
 */
export function linkHeldIndicators(
  lookups: HeldLookupState = {},
  previous: readonly string[] = [],
): string[] {
  const prior = splitIndicators([...previous]);
  const next: string[] = [];
  for (const family of HELD_CLAIM_FAMILIES) {
    const value = lookups[family];
    if (value === undefined) {
      const prefix = HELD_CLAIM_PREFIX[family];
      for (const row of prior) {
        if (row.toLowerCase().startsWith(prefix)) next.push(row);
      }
      continue;
    }
    if (value) next.push(...namedHeldIndicators({ [family]: value }));
  }
  return splitIndicators(next);
}

/**
 * Assemble the Mine overlay Gun user node after SIWE.
 * Wallet + verified (or previously linked) claim ids. Not a public put.
 */
export function assembleMineUser(input: AssembleMineUserInput): User | null {
  const indicators = input.indicators
    ? splitIndicators([...input.indicators])
    : linkHeldIndicators(input.lookups ?? {}, input.previous?.indicators ?? []);
  let checksum: string;
  try {
    checksum = getAddress(input.address);
  } catch {
    return null;
  }
  const samePrevious =
    input.previous &&
    input.previous.id === checksum &&
    sameHeldIndicators(input.previous.indicators, indicators);
  return composeUser({
    address: checksum,
    indicators,
    nowSeconds:
      samePrevious && input.previous ? input.previous.ts : input.nowSeconds,
  });
}

/**
 * Dest re-auth of the assembled overlay. Links claim ids on the dest ACL.
 * Does not put `s3rch/users`. Share-into-mesh is a separate confirm.
 */
export function registerMineUserOverlay(
  acl: SeeAcl,
  user: User,
  owner: string,
): RegisterMineUserResult {
  const admitted = admitComposedUser(acl, user, owner);
  if ("denied" in admitted) return { denied: true };
  return { user, object: admitted.object, node: toGunUserNode(user) };
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
  node: (Partial<GunUserNode> & Record<string, unknown>) | Record<string, unknown> | null | undefined,
): User | null {
  if (!node || typeof node !== "object") return null;
  if (isUnsharePut(node)) return null;
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
  nowSeconds?: number,
): ShareUserResult {
  const published = composeUser({
    address: user.id,
    indicators: sharedIntersection(user, sharedIndicators),
    nowSeconds:
      typeof nowSeconds === "number" && Number.isFinite(nowSeconds)
        ? Math.floor(nowSeconds)
        : user.ts,
  });
  if (!published) return { denied: true };
  const admitted = admitComposedUser(acl, published, owner);
  if ("denied" in admitted) return { denied: true };
  return { node: { ...toGunUserNode(published), unshared: null }, key: published.id };
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
  return { node: { ...toGunUserNode(published), unshared: null }, key: published.id };
}

/**
 * Prepare an explicit unshare tombstone for a previously shared user node.
 * Own-only. Does not revoke see-grants. Overlay claims stay Mine.
 */
export function prepareUnshareUserFromMesh(
  acl: SeeAcl,
  user: User,
  owner: string,
  nowSeconds?: number,
): UnshareResult {
  if (!ownsUser(user, owner)) return { denied: true };
  const admitted = admitComposedUser(acl, user, owner);
  if ("denied" in admitted) return { denied: true };
  return {
    tombstone: userUnshareTombstone(user.id, nowSeconds),
    key: user.id,
  };
}

/**
 * Unshare one held claim by republishing the user node without that indicator.
 * Symmetric to prepareShareClaimIntoMesh. Wallet claim unshares the whole node.
 * A claim that is not currently shared is denied.
 */
export function prepareUnshareClaimFromMesh(
  acl: SeeAcl,
  user: User,
  owner: string,
  claimId: string,
  alreadyShared: readonly string[] = [],
  nowSeconds?: number,
): ShareUserResult | UnshareResult {
  const claim = claimId.trim();
  if (!claim) return { denied: true };
  if (!ownsUser(user, owner)) return { denied: true };

  if (isWalletClaimId(claim, user.id)) {
    return prepareUnshareUserFromMesh(acl, user, owner, nowSeconds);
  }

  const held = user.indicators.some(
    (row) => row.toLowerCase() === claim.toLowerCase(),
  );
  if (!held) return { denied: true };
  if (!claimIsShared(claim, alreadyShared)) return { denied: true };

  const nextShared = alreadyShared.filter(
    (row) => row.trim().toLowerCase() !== claim.toLowerCase(),
  );
  return prepareShareUserIntoMesh(acl, user, owner, nextShared, nowSeconds);
}

export function dropUsers(users: readonly User[], idOrKey: string): User[] {
  return dropById(users, idOrKey);
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
