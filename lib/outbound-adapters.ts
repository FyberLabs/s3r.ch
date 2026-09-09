/**
 * Server-only outbound adapter factory. Do not import from client components.
 */

import { AtprotoOutbound, type AtprotoOutboundOptions } from "./atproto-outbound";
import { UnimplementedOutbound, type OutboundAdapter } from "./bridges";
import {
  FarcasterOutbound,
  type FarcasterOutboundOptions,
} from "./farcaster-outbound";

export type CreateOutboundAdaptersOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  farcaster?: FarcasterOutboundOptions;
  atproto?: AtprotoOutboundOptions;
};

export function createOutboundAdapters(
  options: CreateOutboundAdaptersOptions = {},
): OutboundAdapter[] {
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? fetch;
  return [
    new UnimplementedOutbound("RSS3 Data Sublayer"),
    new UnimplementedOutbound("RSS / Atom"),
    new UnimplementedOutbound("ActivityPub"),
    new AtprotoOutbound({ env, fetch: fetchFn, ...options.atproto }),
    new UnimplementedOutbound("Nostr"),
    new FarcasterOutbound({ env, fetch: fetchFn, ...options.farcaster }),
  ];
}

export const OUTBOUND_ADAPTERS = createOutboundAdapters();
