/**
 * Farcaster Hubble HTTP as a **held claim**, after SIWE.
 *
 * Session subject stays the checksummed Ethereum address. This is not
 * Farcaster SIWF / login and is never written onto the public Gun graph.
 *
 * Verification (same bar as ENS reverse + forward):
 *   1. reverse: session address → FID (current custody, id registry)
 *   2. forward: that FID's latest id-registry `to` must checksum-equal
 *      the session address
 *
 * Then USER_DATA username is display only (fname, or `fid:N` if missing).
 * Unverified / failed hub lookups are a quiet empty claim.
 *
 * Hubble reverse is custody. A verified-only ETH address with no custody
 * record is not shown (no paid Neynar reverse index).
 */

import { getAddress, type Address } from "viem";
import { FARCASTER_HUB_BASE, usernameFromUserData } from "../farcaster";
import { fetchPublic } from "../public-fetch";

export type FarcasterHeldClaim = {
  name: string | null;
};

export type FarcasterIdRegistryEvent = {
  fid: number;
  to: string;
};

export type FarcasterHubClient = {
  idRegistryByAddress: (address: Address) => Promise<FarcasterIdRegistryEvent | null>;
  idRegistryEventsByFid: (fid: number) => Promise<FarcasterIdRegistryEvent[]>;
  userDataByFid: (fid: number) => Promise<unknown>;
};

export function farcasterClaimLine(name: string | null | undefined): string | null {
  if (!name) return null;
  return `Farcaster claim: ${name}`;
}

export function createFarcasterHubClient(
  hubBase: string = FARCASTER_HUB_BASE,
): FarcasterHubClient {
  return {
    async idRegistryByAddress(address) {
      const url = new URL("/v1/onChainIdRegistryEventByAddress", hubBase);
      url.searchParams.set("address", address);
      const body = await fetchHubJson(url);
      return parseIdRegistryEvent(body);
    },
    async idRegistryEventsByFid(fid) {
      const url = new URL("/v1/onChainEventsByFid", hubBase);
      url.searchParams.set("fid", String(fid));
      url.searchParams.set("event_type", "EVENT_TYPE_ID_REGISTER");
      const body = await fetchHubJson(url);
      const events = Array.isArray(body.events) ? body.events : [];
      const parsed: FarcasterIdRegistryEvent[] = [];
      for (const raw of events) {
        const event = parseIdRegistryEvent(raw);
        if (event) parsed.push(event);
      }
      return parsed;
    },
    async userDataByFid(fid) {
      const url = new URL("/v1/userDataByFid", hubBase);
      url.searchParams.set("fid", String(fid));
      return fetchHubJson(url);
    },
  };
}

export async function resolveFarcasterHeldClaim(params: {
  address: string;
  client: FarcasterHubClient;
}): Promise<FarcasterHeldClaim> {
  let checksummed: Address;
  try {
    checksummed = getAddress(params.address);
  } catch {
    return { name: null };
  }

  let reverse: FarcasterIdRegistryEvent | null;
  try {
    reverse = await params.client.idRegistryByAddress(checksummed);
  } catch {
    return { name: null };
  }

  if (!reverse || !Number.isFinite(reverse.fid) || reverse.fid <= 0) {
    return { name: null };
  }

  try {
    if (getAddress(reverse.to) !== checksummed) {
      return { name: null };
    }
  } catch {
    return { name: null };
  }

  let forwardEvents: FarcasterIdRegistryEvent[];
  try {
    forwardEvents = await params.client.idRegistryEventsByFid(reverse.fid);
  } catch {
    return { name: null };
  }

  const current = latestIdRegistryEvent(forwardEvents);
  if (!current || current.fid !== reverse.fid) {
    return { name: null };
  }

  try {
    if (getAddress(current.to) !== checksummed) {
      return { name: null };
    }
  } catch {
    return { name: null };
  }

  let username: string | null = null;
  try {
    username = usernameFromUserData(await params.client.userDataByFid(reverse.fid));
  } catch {
    username = null;
  }

  return { name: username || `fid:${reverse.fid}` };
}

function latestIdRegistryEvent(
  events: FarcasterIdRegistryEvent[],
): FarcasterIdRegistryEvent | null {
  if (events.length === 0) return null;
  return events[events.length - 1] ?? null;
}

function parseIdRegistryEvent(value: unknown): FarcasterIdRegistryEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fid = typeof record.fid === "number" && Number.isFinite(record.fid) ? record.fid : null;
  const body =
    record.idRegisterEventBody &&
    typeof record.idRegisterEventBody === "object" &&
    !Array.isArray(record.idRegisterEventBody)
      ? (record.idRegisterEventBody as Record<string, unknown>)
      : null;
  const to = typeof body?.to === "string" ? body.to : null;
  if (fid === null || !to) return null;
  return { fid, to };
}

async function fetchHubJson(url: URL): Promise<Record<string, unknown>> {
  const response = await fetchPublic(url);
  if (!response.ok) {
    throw new Error(`hub ${url.pathname} HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`hub ${url.pathname} unexpected payload`);
  }
  return body as Record<string, unknown>;
}
