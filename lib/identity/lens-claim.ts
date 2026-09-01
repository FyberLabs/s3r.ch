/**
 * Public Lens GraphQL as a **held claim**, after SIWE.
 *
 * Session subject stays the checksummed Ethereum address. This is not
 * Lens OAuth / login and is never written onto the public Gun graph.
 *
 * Verification (same bar as ENS reverse + forward):
 *   1. reverse: session address → owned Lens account(s)
 *   2. forward: that account's `owner` must checksum-equal the session
 *
 * Managed-only accounts are ignored. Unverified / failed lookups are
 * a quiet empty claim. No Lens API key.
 */

import { getAddress, type Address } from "viem";
import { PUBLIC_FETCH_MS, PUBLIC_USER_AGENT } from "../public-fetch";

export const LENS_GRAPHQL_BASE =
  process.env.LENS_GRAPHQL_BASE ?? "https://api.lens.xyz/graphql";

export type LensHeldClaim = {
  name: string | null;
};

export type LensAccount = {
  address: string;
  owner: string;
  handle: string | null;
};

export type LensLookupClient = {
  accountsOwnedBy: (address: Address) => Promise<LensAccount[]>;
  accountByAddress: (accountAddress: Address) => Promise<LensAccount | null>;
};

const ACCOUNTS_OWNED_QUERY = `
query AccountsOwned($address: EvmAddress!) {
  accountsAvailable(
    request: {
      managedBy: $address
      includeOwned: true
      hiddenFilter: ALL
      pageSize: TEN
    }
  ) {
    items {
      __typename
      ... on AccountOwned {
        account {
          address
          owner
          username { value localName }
        }
      }
    }
  }
}
`;

const ACCOUNT_BY_ADDRESS_QUERY = `
query AccountByAddress($address: EvmAddress!) {
  account(request: { address: $address }) {
    address
    owner
    username { value localName }
  }
}
`;

export function lensClaimLine(name: string | null | undefined): string | null {
  if (!name) return null;
  return `Lens claim: ${name}`;
}

export function createLensLookupClient(
  graphqlBase: string = LENS_GRAPHQL_BASE,
): LensLookupClient {
  return {
    async accountsOwnedBy(address) {
      const data = await lensGraphql(graphqlBase, ACCOUNTS_OWNED_QUERY, {
        address,
      });
      const items = itemsOf(data?.accountsAvailable);
      const owned: LensAccount[] = [];
      for (const item of items) {
        if (!isRecord(item) || item.__typename !== "AccountOwned") continue;
        const account = parseLensAccount(item.account);
        if (account) owned.push(account);
      }
      return owned;
    },
    async accountByAddress(accountAddress) {
      const data = await lensGraphql(graphqlBase, ACCOUNT_BY_ADDRESS_QUERY, {
        address: accountAddress,
      });
      return parseLensAccount(data?.account);
    },
  };
}

export async function resolveLensHeldClaim(params: {
  address: string;
  client: LensLookupClient;
}): Promise<LensHeldClaim> {
  let checksummed: Address;
  try {
    checksummed = getAddress(params.address);
  } catch {
    return { name: null };
  }

  let owned: LensAccount[];
  try {
    owned = await params.client.accountsOwnedBy(checksummed);
  } catch {
    return { name: null };
  }

  for (const candidate of owned) {
    const handle = candidate.handle;
    if (!handle) continue;
    try {
      if (getAddress(candidate.owner) !== checksummed) continue;
    } catch {
      continue;
    }

    let accountAddress: Address;
    try {
      accountAddress = getAddress(candidate.address);
    } catch {
      continue;
    }

    let forwarded: LensAccount | null;
    try {
      forwarded = await params.client.accountByAddress(accountAddress);
    } catch {
      return { name: null };
    }

    if (!forwarded) continue;
    try {
      if (getAddress(forwarded.owner) !== checksummed) continue;
    } catch {
      continue;
    }

    const confirmed = forwarded.handle || handle;
    if (!confirmed) continue;
    return { name: confirmed };
  }

  return { name: null };
}

function parseLensAccount(value: unknown): LensAccount | null {
  if (!isRecord(value)) return null;
  const address = asString(value.address);
  const owner = asString(value.owner);
  if (!address || !owner) return null;
  const username = isRecord(value.username) ? value.username : null;
  const handle = username
    ? asString(username.localName) || asString(username.value)
    : null;
  return { address, owner, handle };
}

async function lensGraphql(
  graphqlBase: string,
  query: string,
  variables: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(graphqlBase, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": PUBLIC_USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`lens graphql HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error("lens graphql unexpected payload");
  }
  if (body.errors) {
    throw new Error("lens graphql errors");
  }
  return isRecord(body.data) ? body.data : null;
}

function itemsOf(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
