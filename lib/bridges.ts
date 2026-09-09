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
    thisSlice: "optional public seeder + address ingest + signed-in rss3-gi pull; /api/ingest or allowlisted extension/relay; gi.rss3.io currently has no DNS",
  },
  {
    network: "RSS / Atom",
    pull: "yes",
    repost: "yes",
    thisSlice: "public seeder + URL ingest + signed-in documented-feed pull; /api/ingest or allowlisted extension/relay",
  },
  {
    network: "ActivityPub",
    pull: "yes",
    repost: "yes",
    thisSlice: "public seeder + signed-in browser pull via actor outbox first page; /api/ingest or allowlisted extension/relay",
  },
  {
    network: "ATProto / Bluesky",
    pull: "yes",
    repost: "yes",
    thisSlice:
      "public seeder + signed-in browser pull via AppView; /api/ingest or allowlisted extension/relay; explicit SIWE outbound via PDS createRecord (server app password)",
  },
  {
    network: "Nostr",
    pull: "yes",
    repost: "yes",
    thisSlice: "public seeder + signed-in browser pull via NIP-01 kind 1 REQ; /api/ingest or allowlisted extension/relay",
  },
  {
    network: "Farcaster",
    pull: "yes",
    repost: "yes",
    thisSlice:
      "public seeder + signed-in browser pull via Hubble HTTP; /api/ingest or allowlisted extension/relay; explicit SIWE outbound via hub submitMessage (server signer)",
  },
  {
    network: "Lens",
    pull: "yes",
    repost: "yes",
    thisSlice: "pull via RSS3 GI only (GI optional / currently no DNS)",
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

/**
 * Documented outbound post interface.
 * Farcaster + ATProto are wired (SIWE + server env). Others stay unimplemented.
 * Share-into-mesh does not call post().
 */
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

/** Built in `createOutboundAdapters()` so client bundles never load hub signers. */
