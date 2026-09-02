/**
 * Polygon UNS Unstoppable reverse + forward as a **held claim**, after SIWE.
 *
 * Session subject stays the checksummed Ethereum address. Unstoppable is
 * never login, never the session key, and never written onto the public
 * Gun graph in this slice. SNS / Solana names are not this slice.
 *
 * Verification (same bar as ENS reverse + forward):
 *   1. reverse: session address → name (`reverseNameOf`)
 *   2. forward: that name → `crypto.ETH.address` must be checksum-equal
 *      to the session address
 *
 * Prefer on-chain Polygon (UNS) via the official ProxyReader. Hosted
 * Resolution Service is a session-gated server fallback that needs
 * `UNSTOPPABLE_API_KEY`. Empty/unset key + on-chain miss = quiet empty
 * (same class as an RSS3 GI miss). Never send the key to the client.
 *
 * Either lookup failing, or a forward mismatch, is a quiet empty claim.
 * Do not surface an unverified reverse. Do not dump RPC / UD errors
 * into the `/feed` hero.
 */

import {
  createPublicClient,
  getAddress,
  http,
  namehash,
  type Address,
} from "viem";
import { polygon } from "viem/chains";
import { PUBLIC_FETCH_MS, PUBLIC_USER_AGENT } from "../public-fetch";

/**
 * Narrow viem / Resolution surface so tests can mock without live RPC or UD.
 * Production uses {@link createUnstoppableLookupClient}.
 */
export type UnstoppableLookupClient = {
  reverseNameOf: (args: { address: Address }) => Promise<string | null>;
  getEthAddress: (args: { name: string }) => Promise<Address | null>;
};

export type UnstoppableHeldClaim = {
  name: string | null;
};

/**
 * Official current Polygon (chain 137) ProxyReader from Unstoppable
 * `uns-config.json` v0.9.11 (resolution src/config, re-checked 2026-09-02).
 * Exposes `reverseNameOf` (IReverseRegistry) and `get` (IRecordReader).
 * There is no separate ReverseResolution deployment in current UNS config;
 * reverse lives on UNSRegistry / this ProxyReader.
 */
export const POLYGON_UNS_PROXY_READER =
  "0x91EDd8708062bd4233f4Dd0FCE15A7cb4d500091" as Address;

/** Official Polygon UNS Registry (IReverseRegistry). */
export const POLYGON_UNS_REGISTRY =
  "0xa9a6A3626993D487d2Dbda3173cf58cA1a9D9e9f" as Address;

/**
 * Legacy Polygon ProxyReader still cited in UD reverse-resolve docs.
 * Current config lists it under `legacyAddresses`. Do not call it.
 */
export const POLYGON_UNS_PROXY_READER_LEGACY =
  "0x423F2531bd5d3C3D4EF7C318c2D1d9BEDE67c680" as Address;

export const CRYPTO_ETH_ADDRESS_KEY = "crypto.ETH.address";

export const UNSTOPPABLE_RESOLVE_BASE =
  "https://api.unstoppabledomains.com/resolve";

export const UNS_PROXY_READER_ABI = [
  {
    type: "function",
    name: "reverseNameOf",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "get",
    stateMutability: "view",
    inputs: [
      { name: "key", type: "string" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/**
 * Server-only Resolution Service key. Empty / unset → null.
 * Never expose via `NEXT_PUBLIC_*`.
 */
export function unstoppableApiKey(
  raw: string | undefined = process.env.UNSTOPPABLE_API_KEY,
): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function trimName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Polygon public client, same unpinned `http()` transport as
 * `lib/identity/ens.ts` on mainnet. No Alchemy / Infura / Azure secret
 * and no UD partner key.
 */
export function createPolygonUnstoppableClient(): UnstoppableLookupClient {
  const client = createPublicClient({
    chain: polygon,
    transport: http(),
  });
  return {
    async reverseNameOf({ address }) {
      const name = await client.readContract({
        address: POLYGON_UNS_PROXY_READER,
        abi: UNS_PROXY_READER_ABI,
        functionName: "reverseNameOf",
        args: [address],
      });
      return trimName(name);
    },
    async getEthAddress({ name }) {
      const value = await client.readContract({
        address: POLYGON_UNS_PROXY_READER,
        abi: UNS_PROXY_READER_ABI,
        functionName: "get",
        args: [CRYPTO_ETH_ADDRESS_KEY, BigInt(namehash(name))],
      });
      const record = trimName(value);
      if (!record) return null;
      try {
        return getAddress(record);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Hosted Resolution Service (`api.unstoppabledomains.com/resolve`).
 * Bearer key is server-side only. Not for the browser (CORS + key).
 */
export function createUnstoppableResolutionClient(
  apiKey: string,
  resolveBase: string = UNSTOPPABLE_RESOLVE_BASE,
): UnstoppableLookupClient {
  const base = resolveBase.replace(/\/$/, "");
  return {
    async reverseNameOf({ address }) {
      const body = await fetchUnstoppableJson(
        `${base}/reverse/${encodeURIComponent(address)}`,
        apiKey,
      );
      const meta = asRecord(asRecord(body)?.meta);
      return trimName(meta?.domain);
    },
    async getEthAddress({ name }) {
      const body = await fetchUnstoppableJson(
        `${base}/domains/${encodeURIComponent(name)}`,
        apiKey,
      );
      const records = asRecord(asRecord(body)?.records);
      const record = trimName(records?.[CRYPTO_ETH_ADDRESS_KEY]);
      if (!record) return null;
      try {
        return getAddress(record);
      } catch {
        return null;
      }
    },
  };
}

/**
 * On-chain first. A thrown RPC / HTTP error may fall back to Resolution
 * when a key exists. A successful empty reverse or forward is final —
 * do not shop a second source for a name the chain already denied.
 */
export function createFallbackUnstoppableClient(opts: {
  primary: UnstoppableLookupClient;
  fallback: UnstoppableLookupClient | null;
}): UnstoppableLookupClient {
  return {
    async reverseNameOf(args) {
      try {
        return await opts.primary.reverseNameOf(args);
      } catch (error) {
        if (!opts.fallback) throw error;
        return opts.fallback.reverseNameOf(args);
      }
    },
    async getEthAddress(args) {
      try {
        return await opts.primary.getEthAddress(args);
      } catch (error) {
        if (!opts.fallback) throw error;
        return opts.fallback.getEthAddress(args);
      }
    },
  };
}

export function createUnstoppableLookupClient(opts?: {
  onChain?: UnstoppableLookupClient;
  apiKey?: string | null;
  resolveBase?: string;
}): UnstoppableLookupClient {
  const primary = opts?.onChain ?? createPolygonUnstoppableClient();
  const key = opts?.apiKey !== undefined ? opts.apiKey : unstoppableApiKey();
  const fallback = key
    ? createUnstoppableResolutionClient(key, opts?.resolveBase)
    : null;
  return createFallbackUnstoppableClient({ primary, fallback });
}

export function unstoppableClaimAddressForSession(
  session: { address?: string } | null | undefined,
): string | null {
  if (!session?.address) return null;
  try {
    return getAddress(session.address);
  } catch {
    return null;
  }
}

/**
 * Gate: no SIWE session → do not call the lookup (no RPC, no
 * `/api/identity/unstoppable`).
 */
export async function lookupUnstoppableHeldClaimForSession(params: {
  session: { address?: string } | null | undefined;
  lookup: (address: string) => Promise<UnstoppableHeldClaim>;
}): Promise<UnstoppableHeldClaim> {
  const address = unstoppableClaimAddressForSession(params.session);
  if (!address) return { name: null };
  return params.lookup(address);
}

export function unstoppableClaimLine(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  return `Unstoppable claim: ${name}`;
}

export async function resolveUnstoppableHeldClaim(params: {
  address: string;
  client: UnstoppableLookupClient;
}): Promise<UnstoppableHeldClaim> {
  let checksummed: Address;
  try {
    checksummed = getAddress(params.address);
  } catch {
    return { name: null };
  }

  let name: string | null;
  try {
    name = await params.client.reverseNameOf({ address: checksummed });
  } catch {
    return { name: null };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { name: null };
  }

  let forwarded: Address | null;
  try {
    forwarded = await params.client.getEthAddress({ name });
  } catch {
    return { name: null };
  }

  if (!forwarded) {
    return { name: null };
  }

  try {
    if (getAddress(forwarded) !== checksummed) {
      return { name: null };
    }
  } catch {
    return { name: null };
  }

  return { name };
}

export type UnstoppableClaimHttpOk = {
  status: 200;
  body: { name: string | null };
};
export type UnstoppableClaimHttpErr = {
  status: 400 | 401 | 403;
  body: { error: string };
};
export type UnstoppableClaimHttpResult =
  | UnstoppableClaimHttpOk
  | UnstoppableClaimHttpErr;

/**
 * Session-gated claim for `GET /api/identity/unstoppable`.
 * Query `address` is optional; when present it must checksum-equal the session.
 * Never returns RPC / Resolution error text. Not an open UD proxy.
 */
export async function resolveSessionUnstoppableClaim(params: {
  sessionAddress: string | null | undefined;
  queryAddress?: string | null;
  client: UnstoppableLookupClient;
}): Promise<UnstoppableClaimHttpResult> {
  const session = unstoppableClaimAddressForSession(
    params.sessionAddress ? { address: params.sessionAddress } : null,
  );
  if (!session) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  if (params.queryAddress) {
    let queried: string;
    try {
      queried = getAddress(params.queryAddress);
    } catch {
      return { status: 400, body: { error: "invalid address" } };
    }
    if (queried !== session) {
      return { status: 403, body: { error: "address does not match session" } };
    }
  }

  const claim = await resolveUnstoppableHeldClaim({
    address: session,
    client: params.client,
  });
  return { status: 200, body: { name: claim.name } };
}

async function fetchUnstoppableJson(
  url: string,
  apiKey: string,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": PUBLIC_USER_AGENT,
    },
    signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`unstoppable resolve HTTP ${response.status}`);
  }
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
