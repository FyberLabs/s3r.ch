# Light Check consume contract (s3r.ch)

This is the artifact the s3r.ch Next app reimplements against.

**File:** [s3rch-check.d.ts](s3rch-check.d.ts)

The Next app runs Check **in the browser** on the Gun mesh. It does **not** import this Rust crate, NAPI, or WASM. Do not `npm install sociacl`. Copy the `.d.ts` or re-type the same names. WASM later is optional and is **not** the lab-feed path.

`crates/sociacl-gun` in FyberLabs/SociACL is the reference implementation. It is not a runtime this app loads.

## What they implement

`CHECK(see, object, accessor)` at `now`.

| Name | Meaning |
| --- | --- |
| `object` | `GunFeedNode` at `s3rch/items/<encodeKey(id)>`, or a held claim id itself (`ens:…` / `unstoppable:…` / `fc:…` / `farcaster:…` / `lens:…` / `rss3:…` / `email:…` / `phone:…` / `kyc:<issuer>:…`) linked from `GunUserNode.indicators`, or a later opaque post/room `CheckObjectId` (s3r.ch rooms / chat / presence keep their existing souls) |
| `accessor` | wallet / Gun peer (`s3rch/users/{wallet}`) |
| `see` | dest Check `read` |
| grant | jointly stated `IdentitySeeGrant` / mesh `MeshSeeGrant`; hopcap **1** (no friend-of-friend) |
| revoke | immediate privilege-down on the dest object (`cancelSee`) |
| hint | `HandoffHint` — untrusted; never a grant |
| hop | optional Social Light `HopFactor`; never a grant; missing does not fail |
| admit | dest re-authorizes **before** `put()` into `items`, `rooms`, that room `chat` set, that room `presence` set, or `users` |

`s3rch/meta` is seed cache. It is not a Check object. A permalink / RSS3 / RSS / issuer URL is a `UrlLeaf`, not a node and not a grant.

Grant **delivery** of a Gun-stored object the dest Check already allows is a holder-initiated put onto `s3rch/granted/<accessor>/{items|rooms|users}`. That path is the accessor inbox — not share-into-mesh and not a public row. Chat / presence / URL fetches are not grant-delivered. Privilege-down stays `cancelSee` on dest ACL (immediate). First delivery can wait on the mesh. Inbox rows die with the ephemeral seed today; dest ACL in IndexedDB does not. Durable-graph / TURN requirements: [durable-graph-and-turn.md](durable-graph-and-turn.md). Do not put SIWE signatures, mesh-key private material, or TURN secrets on a grant envelope.

Later, on request: more verbs on the TS spec. Not this cut.

## Locked Gun paths (do not fork)

```
gun.get('s3rch').get('items').get(encodeKey(id))  → GunFeedNode
gun.get('s3rch').get('rooms').get(encodeKey(id))  → GunRoomNode
gun.get('s3rch').get('rooms').get(encodeKey(id)).get('chat').get(encodeKey(mid))  → GunChatNode
gun.get('s3rch').get('rooms').get(encodeKey(id)).get('presence').get(encodeKey(address))  → GunPresenceNode
gun.get('s3rch').get('meta')                     → seed meta (not a Check object)
gun.get('s3rch').get('users').get(wallet)        → GunUserNode
gun.get('s3rch').get('granted').get(accessor).get('items'|'rooms'|'users').get(encodeKey(id))
                                                 → grant-delivery envelope (not a public row)
gun.get('s3rch').get('acl').get(aclPrincipalKey(owner))
     .get(aclKey(object)).get(aclPrincipalKey(accessor))  → MeshSeeGrant
```

`encodeKey`: `id.replace(/[.#$\[\]]/g, '_')`.

`aclKey`: `encodeKey` then `/` → `_` so dest-ACL souls stay five segments. Not a second `encodeKey` for items or users.

Held-claim object id is the **claim id itself** (`ens:name.eth`, `unstoppable:…`, `fc:…` / `farcaster:…`, `lens:…`, `rss3:0x…`, `email:…`, `phone:…`, `kyc:<issuer>:…`), linked from `GunUserNode.indicators` on `s3rch/users/<wallet>`. Mesh Check treats those ids the same as `GunFeedNode` ids. Do not invent `s3rch/users/<wallet>/claims/…`. Overlay uses the same `GunUserNode` shape until s3r.ch `prepareShareUserIntoMesh` / `prepareShareClaimIntoMesh`. Posts / rooms stay opaque `CheckObjectId`s — s3r.ch owns those souls.

The Rust crate remains the full plane. See [FyberLabs/SociACL docs/gun.md](https://github.com/FyberLabs/SociACL/blob/master/docs/gun.md) for that map. Social Light hop wire: [FyberLabs/SociACL docs/social-light.md](https://github.com/FyberLabs/SociACL/blob/master/docs/social-light.md).

## Mesh

This is the cut the s3r.ch Next app wires after held-claims land.

**Copy / re-type:** [s3rch-check.d.ts](s3rch-check.d.ts) (one file; Mesh section is at the bottom). Do not `npm install sociacl`. Do not import the crate, NAPI, or WASM.

### Dest ACL soul

See grants are Gun nodes under the **object owner's dest ACL**, not under `items` or `users`:

```
s3rch/acl/<aclPrincipalKey(owner)>/<aclKey(object)>/<aclPrincipalKey(accessor)>
```

`s3rch/users/<wallet>` collapses to the wallet on dest ACL. Examples:

```
s3rch/acl/0xalice/rss3:act_1_x/0xbob          // feed item rss3:act/1#x
s3rch/acl/0xalice/ens:alice_eth/0xbob         // held claim ens:alice.eth
```

Each field HAM-merges. `MeshSeeGrant.stated` is `1` (live) or `0` (cancelled). Cancel is owner-only and **must bump Gun HAM state** so privilege-down wins the next merge. Each peer runs `checkSee` on its locally HAM-merged graph at `now`. Do not cache an allow across a privilege-down merge.

`s3rch/acl` itself is not a Check object (same as `meta`). Lab dest ACL in IndexedDB stays the immediate privilege-down store. Mesh rows on Gun let peers evaluate the same Check when the seed / WebRTC graph has the ACL row.

Grant ≠ share ≠ delivery ≠ unshare.

### Objects in scope

| Object | Id | In-graph? |
| --- | --- | --- |
| Feed item | `s3rch/items/<encodeKey(id)>` | yes, after dest admit |
| Held claim | claim id itself (`ens:…` / `unstoppable:…` / `fc:…` / `farcaster:…` / `lens:…` / `rss3:…`), linked from `GunUserNode.indicators` | yes, after dest admit / s3r.ch `prepareShareClaimIntoMesh` |
| Post / room | opaque `CheckObjectId` (s3r.ch names the soul) | yes, after dest admit |
| Mine overlay | same `GunUserNode` shape, local only | **no** until s3r.ch `prepareShare*` then `putObject` |
| Permalink / RSS3 / issuer HTTP | `UrlLeaf` | never |

### Hop factor

`checkSee(graph, object, accessor, now, hint?, hop?)`.

- hop missing does not fail.
- hop alone never allows.
- `hop` may only factor an already-named grant or owner path.
- `acceptHop` / `decodeHop` do not verify and do not mint (mirror `acceptHint`).
- URL handoffs stay untrusted `HandoffHint`. A hint plus a hop still fail closed without dest ACL.

Reuse SociACL Social Light (`convention-badge` / `enrolled-station`, SLHP v1). Do not reimplement the hop frame beyond the consume types. No hop UI on public `/` or `/feed`.
