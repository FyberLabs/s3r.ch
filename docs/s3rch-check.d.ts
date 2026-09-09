/**
 * Light Check consume contract for s3r.ch.
 *
 * Copy or re-type these names in the Next app. Run Check in the
 * browser on the Gun mesh. Do not import the SociACL Rust crate.
 * Do not add this file as an npm package. This is a contract, not
 * a dependency.
 *
 * Reference implementation (Rust, this repo): crates/sociacl-gun.
 *
 * CHECK(see, object, accessor) at now.
 *   object   = GunFeedNode | held claim id | later opaque post/room
 *   claim id = the id itself (ens:… / unstoppable:… / fc:… / lens:… /
 *              rss3:…), linked from GunUserNode.indicators
 *   Do not invent s3rch/users/<wallet>/claims/…
 *   accessor = wallet / Gun peer
 *   hopcap 1, jointly stated grants, revoke immediate
 *   hop      = optional Social Light factor; never a grant
 */

/** Locked Gun root. */
export type S3rchRoot = "s3rch";

export type FeedSource = "rss3" | "rss" | "atom";

/**
 * In-graph feed node. Native Check object.
 * gun.get('s3rch').get('items').get(encodeKey(id))
 * Gun cannot store arrays: `tags` is a comma-separated string.
 */
export type GunFeedNode = {
  id: string;
  source: string;
  kind: string;
  author: string;
  body: string;
  ts: number;
  permalink: string;
  tags: string;
  provenance: string;
  /** Missing on old seed rows; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/**
 * UX only. tags is a list. Mapping is toGunNode / fromGunNode.
 * Dedupe: canonical id, else normalized permalink.
 */
export type FeedItem = {
  id: string;
  source: FeedSource;
  kind: string;
  author: string;
  body: string;
  ts: number;
  permalink: string;
  tags: string[];
  provenance: string;
  v?: number;
};

/**
 * In-graph room node. Native Check object.
 * gun.get('s3rch').get('rooms').get(encodeKey(id))
 * Gun cannot store arrays: `tags` is a comma-separated string.
 */
export type GunRoomNode = {
  id: string;
  title: string;
  owner: string;
  tags: string;
  ts: number;
  provenance: string;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/**
 * In-graph chat node. Native Check object.
 * gun.get('s3rch').get('rooms').get(encodeKey(room)).get('chat').get(encodeKey(id))
 */
export type GunChatNode = {
  id: string;
  room: string;
  author: string;
  body: string;
  ts: number;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/**
 * In-graph presence node. Native Check object.
 * gun.get('s3rch').get('rooms').get(encodeKey(room)).get('presence').get(encodeKey(address))
 */
export type GunPresenceNode = {
  room: string;
  address: string;
  ts: number;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/**
 * In-graph user node. Native Check object.
 * gun.get('s3rch').get('users').get(wallet)
 * On the Gun wire, indicators are a comma-separated string.
 * Grant delivery of this node (or one named claim) uses
 * s3rch/granted/<accessor>/users — not this public path.
 */
export type GunUserNode = {
  id: string;
  indicators: string;
  provenance: string;
  ts: number;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/** Issuers prove a claim to the holder. They are not grants. */
export type IdentityClaimKind =
  | "wallet"
  | "rss3"
  | "ens"
  | "kyc_attestation"
  | "email"
  | "phone";

/**
 * Jointly stated see grant. hopcap 1. Privilege-down is immediate.
 * `from` inclusive, `until` exclusive. Dest stores `until`; Check
 * ANDs now ∈ [from, until).
 */
export type IdentitySeeGrant = {
  claimId: string;
  accessor: string;
  from: number;
  until: number;
};

/**
 * Untrusted edge handoff (ingest / seeder / URL cross).
 * user/agent id as we name them, claimed target, optional verb/context.
 * Decode does not verify. A hint never sets allowed.
 */
export type HandoffHint = {
  principal: string;
  target: string;
  verb?: string;
  context?: string;
};

/**
 * Permalink, RSS3 GI, RSS/Atom, or issuer HTTP.
 * Not a Gun node. Not a grant. A URL 200 is not see.
 */
export type UrlLeaf = {
  url: string;
};

/** Seed cache. gun.get('s3rch').get('meta'). Not a Check object. */
export type FeedMeta = {
  seededAt?: string;
  sourcesOk: number;
  sourcesTried: number;
  error?: string;
  count: number;
};

/** Feed item soul or claim id linked from the user node. */
export type CheckObjectId = string;

/** Wallet or s3rch/users/{wallet}. */
export type AccessorId = string;

export type CheckResult = {
  allowed: boolean;
  /**
   * Predicate / deny reason. A present hint never makes this a grant.
   * A present hop never makes this a grant.
   */
  reason: string;
};

/**
 * Live graph the browser reads. Only in-graph objects and jointly
 * stated see grants. Do not walk friend edges (hopcap 1).
 *
 * Mesh: each peer evaluates against its locally HAM-merged Gun graph
 * at now. Do not cache an allow across a privilege-down merge.
 */
export type SeeGraph = {
  hasObject(object: CheckObjectId): boolean;
  ownerOf(object: CheckObjectId): AccessorId | undefined;
  seeGrants(object: CheckObjectId): readonly IdentitySeeGrant[];
};

/** Writable dest ACL. Cancel and admit land here, not on a URL. */
export type SeeAcl = SeeGraph & {
  putObject(object: CheckObjectId, owner: AccessorId): void;
  stateSeeGrant(owner: AccessorId, grant: IdentitySeeGrant): void;
  unstateSeeGrant(
    owner: AccessorId,
    accessor: AccessorId,
    object: CheckObjectId,
  ): void;
};

/** id.replace(/[.#$\[\]]/g, '_') */
export function encodeKey(id: string): string;

/** s3rch/items/<encodeKey(id)> */
export function itemSoul(id: string): string;

/** s3rch/rooms/<encodeKey(id)> */
export function roomSoul(id: string): string;

/** s3rch/rooms/<encodeKey(roomId)>/chat/<encodeKey(id)> */
export function chatSoul(roomId: string, messageId: string): string;

/** s3rch/rooms/<encodeKey(roomId)>/presence/<encodeKey(address)> */
export function presenceSoul(roomId: string, address: string): string;

/** s3rch/users/<wallet> */
export function userSoul(wallet: string): string;

/**
 * s3rch/granted/<accessor>/{items|rooms|users}/<encodeKey(id)>
 * Holder-initiated delivery inbox. Not share-into-mesh. Not a Check object
 * of its own — dest Check gates the put / accept.
 */
export function grantedSoul(
  accessor: AccessorId,
  kind: "items" | "rooms" | "users",
  objectId: string,
): string;

/** s3rch/meta — not a Check object. */
export function metaSoul(): string;

export function toGunNode(item: FeedItem): GunFeedNode;

/** Unknown source is not a feed node. Empty kind → "activity". */
export function fromGunNode(
  node: Partial<GunFeedNode> | null | undefined,
): FeedItem | null;

/** Does not verify. Does not mint. */
export function acceptHint(hint: HandoffHint): HandoffHint;

/**
 * CHECK(see, object, accessor) at now.
 * see maps to dest read. Hint is ignored for allowed.
 * Hop missing does not fail. Hop alone never allows. Hop may only
 * factor an already-named grant or owner path.
 * Owner sees their object. Else a live IdentitySeeGrant / MeshSeeGrant
 * must name this pair and now ∈ [from, until). meta, dest ACL souls,
 * and UrlLeaf fail closed.
 */
export function checkSee(
  graph: SeeGraph,
  object: CheckObjectId,
  accessor: AccessorId,
  now: number,
  hint?: HandoffHint,
  hop?: HopFactor,
): CheckResult;

/**
 * Dest Check AND the presented grant window.
 * from denies until now is in range.
 */
export function checkSeeGrant(
  graph: SeeGraph,
  grant: IdentitySeeGrant,
  object: CheckObjectId,
  accessor: AccessorId,
  now: number,
  hint?: HandoffHint,
  hop?: HopFactor,
): CheckResult;

/**
 * Destination re-authorizes, then may put a GunFeedNode into items.
 * Hint / URL fetch is not authorization.
 */
export function admitFeedNode(
  acl: SeeAcl,
  node: GunFeedNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true };

/**
 * Destination re-authorizes, then may put a GunRoomNode into rooms.
 * Hint / URL fetch is not authorization.
 */
export function admitRoomNode(
  acl: SeeAcl,
  node: GunRoomNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true };

/**
 * Destination re-authorizes, then may put a GunChatNode onto room chat.
 * Hint / URL fetch is not authorization.
 */
export function admitChatNode(
  acl: SeeAcl,
  node: GunChatNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true };

/**
 * Destination re-authorizes, then may put a GunPresenceNode onto room presence.
 * Hint / URL fetch is not authorization.
 */
export function admitPresenceNode(
  acl: SeeAcl,
  node: GunPresenceNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true };

/**
 * Destination re-authorizes, then may put a GunUserNode into users.
 * Hint / URL fetch is not authorization.
 */
export function admitUserNode(
  acl: SeeAcl,
  node: GunUserNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true };

/** Jointly stated. hopcap 1. */
export function applySeeGrant(
  acl: SeeAcl,
  owner: AccessorId,
  grant: IdentitySeeGrant,
): void;

/** Privilege-down is immediate. Dest ACL only. */
export function cancelSee(
  acl: SeeAcl,
  owner: AccessorId,
  accessor: AccessorId,
  object: CheckObjectId,
): void;

/* -------------------------------------------------------------------------- */
/* Mesh — dest ACL + Social Light hop factor                                  */
/*                                                                            */
/* Copy / re-type with the types above. Same file. Not an npm package.        */
/* Grants HAM-merge under s3rch/acl. They do not fork items or users.         */
/* Held claim CheckObjectId = claim id itself (ens:… / fc:… / …).             */
/* Linked from GunUserNode.indicators. No users/<wallet>/claims/ path.        */
/* Overlay stays local until s3r.ch prepareShare* then putObject.             */
/* -------------------------------------------------------------------------- */

/** Dest ACL collection. Sibling of items / users / meta. Not a Check object. */
export type S3rchAcl = "acl";

/**
 * Held-claim CheckObjectId prefixes locked by s3r.ch.
 * The object id is the claim id itself, linked from
 * GunUserNode.indicators. Same Mesh Check path as a GunFeedNode id.
 * s3r.ch #46 also links `farcaster:` (same family as `fc:`).
 */
export type HeldClaimPrefix =
  | "ens:"
  | "unstoppable:"
  | "fc:"
  | "farcaster:"
  | "lens:"
  | "rss3:";

/**
 * Dest-ACL path key. encodeKey, then `/` → `_`, so a grant soul stays
 * five segments when the object id still contains slashes
 * (`rss3:act/1_x`, `s3rch/items/…`). Not a second encodeKey for items
 * or users.
 */
export function aclKey(id: string): string;

/**
 * Owner / accessor key on dest ACL. `s3rch/users/<wallet>` collapses
 * to the wallet. Anything else is aclKey.
 */
export function aclPrincipalKey(id: string): string;

/**
 * Owner dest-ACL root. Not a Check object.
 * gun.get('s3rch').get('acl').get(aclPrincipalKey(owner))
 */
export function aclSoul(owner: AccessorId): string;

/**
 * Jointly stated see grant under the object owner's dest ACL.
 * Does not fork items or users.
 * gun.get('s3rch').get('acl')
 *   .get(aclPrincipalKey(owner))
 *   .get(aclKey(object))
 *   .get(aclPrincipalKey(accessor))
 */
export function grantSoul(
  owner: AccessorId,
  object: CheckObjectId,
  accessor: AccessorId,
): string;

/**
 * In-graph see grant. HAM-merges across peers.
 * `stated` 1 = jointly stated, 0 = cancelled (privilege-down).
 * `from` inclusive, `until` exclusive.
 * Cancel is owner-only on dest ACL and must bump Gun HAM state so
 * the next Check after merge denies. Do not cache an allow.
 */
export type MeshSeeGrant = {
  object: CheckObjectId;
  accessor: AccessorId;
  from: number;
  until: number;
  stated: 0 | 1;
};

/**
 * One dest-ACL grant node. Soul is grantSoul(owner, object, accessor).
 * Peers HAM-merge by hamState (higher wins). Cancel bumps hamState.
 */
export type GunAclEdge = {
  soul: string;
  owner: AccessorId;
  grant: MeshSeeGrant;
  hamState: number;
};

/** Named Social Light channels. Same as sociacl-core. Hop is not a grant. */
export type SocialLightChannel = "convention-badge" | "enrolled-station";

/**
 * Optional Check factor. Opaque SLHP bytes or the structured hop
 * sociacl-core already names. Destination re-authorizes.
 * Hop missing does not fail. Hop alone never allows.
 * Hop never mints a grant. URL handoffs stay untrusted HandoffHint.
 */
export type HopFactor =
  | Uint8Array
  | {
      channel: SocialLightChannel;
      attestationBytes?: Uint8Array;
      shareToken?: string;
    };

/**
 * Identity. Does not verify. Does not mint. Mirror acceptHint.
 */
export function acceptHop(hop: HopFactor): HopFactor;

/**
 * SLHP decode. Does not verify. Does not mint. Mirror acceptHint.
 * Attestation bytes stay opaque.
 */
export function decodeHop(bytes: Uint8Array): HopFactor;
