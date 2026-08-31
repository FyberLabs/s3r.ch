/**
 * Honest pull / repost matrix. "yes" means a real API exists, not that
 * this slice implements it. Walled gardens stay "no" — no theater.
 */

export type BridgeSupport = "yes" | "no";

export type NetworkBridge = {
  network: string;
  pull: BridgeSupport;
  repost: BridgeSupport;
  thisSlice: string;
};

export const BRIDGE_MATRIX: NetworkBridge[] = [
  {
    network: "RSS3 Data Sublayer",
    pull: "yes",
    repost: "yes",
    thisSlice: "public seeder + address ingest",
  },
  {
    network: "RSS / Atom",
    pull: "yes",
    repost: "yes",
    thisSlice: "URL ingest (normalize only)",
  },
  {
    network: "ActivityPub",
    pull: "yes",
    repost: "yes",
    thisSlice: "not wired",
  },
  {
    network: "ATProto / Bluesky",
    pull: "yes",
    repost: "yes",
    thisSlice: "not wired",
  },
  {
    network: "Nostr",
    pull: "yes",
    repost: "yes",
    thisSlice: "not wired",
  },
  {
    network: "Farcaster",
    pull: "yes",
    repost: "yes",
    thisSlice: "pull via RSS3 only",
  },
  {
    network: "Lens",
    pull: "yes",
    repost: "yes",
    thisSlice: "pull via RSS3 only",
  },
  {
    network: "Instagram",
    pull: "no",
    repost: "no",
    thisSlice: "none",
  },
  {
    network: "TikTok",
    pull: "no",
    repost: "no",
    thisSlice: "none",
  },
  {
    network: "Facebook",
    pull: "no",
    repost: "no",
    thisSlice: "none",
  },
  {
    network: "X (locked-down)",
    pull: "no",
    repost: "no",
    thisSlice: "none",
  },
];

export type OutboundDraft = {
  body: string;
  permalink?: string;
  tags?: string[];
};

export type OutboundResult =
  | { ok: true; network: string; url: string }
  | { ok: false; network: string; reason: string };

/** Outbound posting is not wired. Do not claim it works. */
export interface OutboundAdapter {
  readonly network: string;
  readonly enabled: boolean;
  post(draft: OutboundDraft): Promise<OutboundResult>;
}

export class UnimplementedOutbound implements OutboundAdapter {
  readonly enabled = false;

  constructor(readonly network: string) {}

  async post(_draft: OutboundDraft): Promise<OutboundResult> {
    return {
      ok: false,
      network: this.network,
      reason: "Outbound is not wired in this slice.",
    };
  }
}

export const OUTBOUND_ADAPTERS: OutboundAdapter[] = [
  new UnimplementedOutbound("RSS3 Data Sublayer"),
  new UnimplementedOutbound("RSS / Atom"),
  new UnimplementedOutbound("ActivityPub"),
  new UnimplementedOutbound("ATProto / Bluesky"),
  new UnimplementedOutbound("Nostr"),
  new UnimplementedOutbound("Farcaster"),
];
