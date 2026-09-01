/**
 * Mainnet ENS reverse + forward as a **held claim**, after SIWE.
 *
 * Session subject stays the checksummed Ethereum address. ENS is never login
 * and never written onto the public Gun graph in this slice.
 *
 * Verification:
 *   1. reverse: address → name (ENS reverse record)
 *   2. forward: that name → address must be checksum-equal to the session
 *
 * Either lookup failing, or a forward mismatch, is a quiet empty claim.
 * Do not surface an unverified reverse.
 */

import { createPublicClient, getAddress, http, type Address } from "viem";
import { mainnet } from "viem/chains";

/**
 * Narrow viem surface so tests can mock without a live RPC.
 * Production uses {@link createMainnetEnsClient}.
 */
export type EnsLookupClient = {
  getEnsName: (args: { address: Address }) => Promise<string | null>;
  getEnsAddress: (args: { name: string }) => Promise<Address | null>;
};

export type EnsHeldClaim = {
  name: string | null;
};

/**
 * Mainnet public client, same `http()` transport as `lib/identity/wagmi.ts`.
 * No Azure / Alchemy / Infura secret. viem's default mainnet public endpoint
 * is enough for this lab slice; pin a public HTTP URL later if it flakes.
 */
export function createMainnetEnsClient(): EnsLookupClient {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(),
  });
  return {
    getEnsName: (args) => client.getEnsName(args),
    getEnsAddress: (args) => client.getEnsAddress(args),
  };
}

export function ensClaimAddressForSession(
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
 * Gate: no SIWE session → do not call the lookup (no RPC, no `/api/identity/ens`).
 */
export async function lookupEnsHeldClaimForSession(params: {
  session: { address?: string } | null | undefined;
  lookup: (address: string) => Promise<EnsHeldClaim>;
}): Promise<EnsHeldClaim> {
  const address = ensClaimAddressForSession(params.session);
  if (!address) return { name: null };
  return params.lookup(address);
}

export function ensClaimLine(name: string | null | undefined): string | null {
  if (!name) return null;
  return `ENS claim: ${name}`;
}

export async function resolveEnsHeldClaim(params: {
  address: string;
  client: EnsLookupClient;
}): Promise<EnsHeldClaim> {
  let checksummed: Address;
  try {
    checksummed = getAddress(params.address);
  } catch {
    return { name: null };
  }

  let name: string | null;
  try {
    name = await params.client.getEnsName({ address: checksummed });
  } catch {
    return { name: null };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { name: null };
  }

  let forwarded: Address | null;
  try {
    forwarded = await params.client.getEnsAddress({ name });
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

export type EnsClaimHttpOk = { status: 200; body: { name: string | null } };
export type EnsClaimHttpErr = {
  status: 400 | 401 | 403;
  body: { error: string };
};
export type EnsClaimHttpResult = EnsClaimHttpOk | EnsClaimHttpErr;

/**
 * Session-gated claim for `GET /api/identity/ens`.
 * Query `address` is optional; when present it must checksum-equal the session.
 * Never returns RPC error text.
 */
export async function resolveSessionEnsClaim(params: {
  sessionAddress: string | null | undefined;
  queryAddress?: string | null;
  client: EnsLookupClient;
}): Promise<EnsClaimHttpResult> {
  const session = ensClaimAddressForSession(
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

  const claim = await resolveEnsHeldClaim({
    address: session,
    client: params.client,
  });
  return { status: 200, body: { name: claim.name } };
}
