/**
 * Optional RSS3 GI account overlay as a **held claim**, after SIWE.
 *
 * Session subject stays the checksummed Ethereum address. This is not
 * RSS3 login and is never written onto the public Gun graph. Do not
 * dump account activity, casts, or tx graphs as identity.
 *
 * GI (`https://gi.rss3.io`) is documented as optional / currently
 * DNS-dead. A GI miss is a quiet empty RSS3 claim, not a reason to
 * drop Farcaster or Lens.
 *
 * Verification (same bar as ENS reverse + forward):
 *   1. reverse: session address → GI `GET /decentralized/{account}`
 *   2. forward: at least one activity `owner` checksum-equals the session
 *
 * Display is a quiet label (platform set, or "footprint") — not a feed.
 */

import { getAddress, type Address } from "viem";
import { fetchPublic } from "../public-fetch";
import { GI_BASE } from "../rss3";

export type Rss3HeldClaim = {
  name: string | null;
};

export type Rss3ActivityHint = {
  owner?: string | null;
  platform?: string | null;
};

export type Rss3GiClient = {
  accountOverlay: (account: Address) => Promise<Rss3ActivityHint[] | null>;
};

const OVERLAY_LIMIT = 10;
const PLATFORM_CAP = 3;

export function rss3ClaimLine(name: string | null | undefined): string | null {
  if (!name) return null;
  return `RSS3 claim: ${name}`;
}

export function createRss3GiClient(giBase: string = GI_BASE): Rss3GiClient {
  return {
    async accountOverlay(account) {
      const url = new URL(`/decentralized/${encodeURIComponent(account)}`, giBase);
      url.searchParams.set("limit", String(OVERLAY_LIMIT));
      url.searchParams.set("action_limit", "1");
      const response = await fetchPublic(url);
      if (!response.ok) {
        throw new Error(`rss3 gi HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new Error("rss3 gi unexpected payload");
      }
      return body.data.filter(isRecord).map((row) => ({
        owner: asString(row.owner),
        platform: asString(row.platform),
      }));
    },
  };
}

export async function resolveRss3HeldClaim(params: {
  address: string;
  client: Rss3GiClient;
}): Promise<Rss3HeldClaim> {
  let checksummed: Address;
  try {
    checksummed = getAddress(params.address);
  } catch {
    return { name: null };
  }

  let overlay: Rss3ActivityHint[] | null;
  try {
    overlay = await params.client.accountOverlay(checksummed);
  } catch {
    return { name: null };
  }

  if (!overlay || overlay.length === 0) {
    return { name: null };
  }

  const bound: Rss3ActivityHint[] = [];
  for (const row of overlay) {
    if (!row.owner) continue;
    try {
      if (getAddress(row.owner) === checksummed) bound.push(row);
    } catch {
      // skip junk owner fields
    }
  }

  if (bound.length === 0) {
    return { name: null };
  }

  return { name: rss3ClaimLabel(bound) };
}

export function rss3ClaimLabel(bound: Rss3ActivityHint[]): string {
  const platforms: string[] = [];
  const seen = new Set<string>();
  for (const row of bound) {
    const platform = row.platform;
    if (!platform) continue;
    const key = platform.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    platforms.push(platform);
    if (platforms.length >= PLATFORM_CAP) break;
  }
  return platforms.length > 0 ? platforms.join(", ") : "footprint";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
