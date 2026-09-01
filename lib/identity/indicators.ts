/**
 * Session-gated public-indicator held claims after SIWE.
 *
 * ENS stays on its own route (`lib/identity/ens.ts`). This module
 * resolves Farcaster, Lens, and RSS3 in one trip so IdentityBar does
 * not fire three uncoordinated lookups. Failures are isolated: a GI
 * miss does not drop Farcaster or Lens.
 *
 * Never writes claims onto the public Gun graph. Indicators are not
 * stored in the session cookie.
 */

import { getAddress } from "viem";
import {
  createFarcasterHubClient,
  resolveFarcasterHeldClaim,
  type FarcasterHeldClaim,
  type FarcasterHubClient,
} from "./farcaster-claim";
import {
  createLensLookupClient,
  resolveLensHeldClaim,
  type LensHeldClaim,
  type LensLookupClient,
} from "./lens-claim";
import {
  createRss3GiClient,
  resolveRss3HeldClaim,
  type Rss3GiClient,
  type Rss3HeldClaim,
} from "./rss3-claim";

export type PublicIndicators = {
  farcaster: FarcasterHeldClaim;
  lens: LensHeldClaim;
  rss3: Rss3HeldClaim;
};

export type IndicatorClients = {
  farcaster: FarcasterHubClient;
  lens: LensLookupClient;
  rss3: Rss3GiClient;
};

export function emptyIndicators(): PublicIndicators {
  return {
    farcaster: { name: null },
    lens: { name: null },
    rss3: { name: null },
  };
}

export function claimAddressForSession(
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
 * Gate: no SIWE session → do not call public indicator lookups.
 */
export async function lookupIndicatorsForSession(params: {
  session: { address?: string } | null | undefined;
  lookup: (address: string) => Promise<PublicIndicators>;
}): Promise<PublicIndicators> {
  const address = claimAddressForSession(params.session);
  if (!address) return emptyIndicators();
  return params.lookup(address);
}

export function createIndicatorClients(): IndicatorClients {
  return {
    farcaster: createFarcasterHubClient(),
    lens: createLensLookupClient(),
    rss3: createRss3GiClient(),
  };
}

export async function resolvePublicIndicators(params: {
  address: string;
  clients: IndicatorClients;
}): Promise<PublicIndicators> {
  const [farcaster, lens, rss3] = await Promise.all([
    resolveFarcasterHeldClaim({
      address: params.address,
      client: params.clients.farcaster,
    }),
    resolveLensHeldClaim({
      address: params.address,
      client: params.clients.lens,
    }),
    resolveRss3HeldClaim({
      address: params.address,
      client: params.clients.rss3,
    }),
  ]);
  return { farcaster, lens, rss3 };
}

export type IndicatorsHttpOk = { status: 200; body: PublicIndicators };
export type IndicatorsHttpErr = {
  status: 400 | 401 | 403;
  body: { error: string };
};
export type IndicatorsHttpResult = IndicatorsHttpOk | IndicatorsHttpErr;

/**
 * Session-gated claims for `GET /api/identity/indicators`.
 * Query `address` is optional; when present it must checksum-equal the session.
 * Never returns hub / GraphQL / GI error text.
 */
export async function resolveSessionIndicators(params: {
  sessionAddress: string | null | undefined;
  queryAddress?: string | null;
  clients: IndicatorClients;
}): Promise<IndicatorsHttpResult> {
  const session = claimAddressForSession(
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

  const body = await resolvePublicIndicators({
    address: session,
    clients: params.clients,
  });
  return { status: 200, body };
}
