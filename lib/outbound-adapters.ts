/**
 * Server-only outbound adapter factory. Do not import from client components.
 */

import { MastodonOutbound } from "./mastodon-outbound";
import { NostrOutbound } from "./nostr-outbound";
import { AtprotoOutbound, type AtprotoOutboundOptions } from "./atproto-outbound";
import { UnimplementedOutbound, type OutboundAdapter } from "./bridges";
import {
  FarcasterOutbound,
  type FarcasterOutboundOptions,
} from "./farcaster-outbound";

export type CreateOutboundAdaptersOptions = {
  owner?: string;
  signal?: AbortSignal;
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
    new MastodonOutbound({env, owner:options.owner, signal:options.signal, fetch:fetchFn}),
    new AtprotoOutbound({ env, fetch: fetchFn, ...options.atproto }),
    new NostrOutbound({env, owner: options.owner, signal: options.signal}),
    new FarcasterOutbound({ env, fetch: fetchFn, ...options.farcaster }),
  ];
}

export const OUTBOUND_ADAPTERS = createOutboundAdapters();
