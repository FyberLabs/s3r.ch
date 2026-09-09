# s3r.ch architecture (2026-09-08)

Internal notes for the lab prototype. This is not a public `/research` route, not a protocol spec, and not tokenomics.

s3r.ch is a Fyber Labs lab site. **Gun is the graph.** RSS3 Data Sublayer activity and other allowed sites / crypto-social sources concentrate on that graph. Popular items cache across peers. The same graph is the unique real-time streaming / chat / sharing network — **mostly browser-to-browser**, not a chat server we host.

## Public copy

Landing, `/feed` hero, metadata, and chrome are customer-facing (what a visitor can do). Prefer empty UI over essays. Architecture locks stay in this file and README — including seed-peer / WebRTC / STUN≠TURN status, snapshot vs mesh, see-grant vs share, unshare tombstones, CORS `/api/ingest`, SIWE / EOA / ERC-1271, held-claim line wording (`ENS claim: …`), passkey PRF wrap, paper backup, and WalletConnect-as-IdP bans. Do not recopy those onto public pages. Session, Discover, Rooms, and tab chrome are controls and empty states only. Empty Network / Granted when the seed socket is down still mean the same thing in code; the UI says nothing is here yet, not the lock sentence.

This slice **does** ship EIP-4361 SIWE login (EOA ecrecover plus mainnet ERC-1271 / EIP-6492 for smart accounts), a signed cookie session, mainnet ENS / Unstoppable / Farcaster / Lens / RSS3 held claims after auth, a **Gun user node** keyed by the checksummed wallet (`GunUserNode` on `s3rch/users/<wallet>`, `v: 1`), **explicit share-into-mesh** of that user node and of individual held claims (Mine until share), light SociACL **Check see-grants** in the browser (see [identity.md](identity.md) and [s3rch-check.md](s3rch-check.md)), **live mesh delivery** of granted Gun-stored objects onto `s3rch/granted/<accessor>/{items|rooms|users}` (holder put; accessor **Granted** tab after SIWE), **signed-in browser pull** of the same documented public sources the lab seeder uses (Farcaster hub FIDs, ATProto AppView, RSS/Atom, ActivityPub actor outbox, Nostr kind 1 relay query, optional RSS3 GI) through the same-origin `/api/ingest` CORS proxy, admit `GunFeedNode` `v: 1` onto Mine, and optional explicit share-into-mesh HAM-merge onto `s3rch/items`, **native s3r.ch posts** (mine by default), **rooms as Gun threads** (Mine by default, Check on the room object, explicit share of the room node), **live chat UI over Gun subscriptions** on a room the user can already see (Mine overlay until that room node is on `s3rch/rooms`; public-room chat HAM-merges through the same-origin `/gun` seed peer), **room presence** (`GunPresenceNode` on `s3rch/rooms/<id>/presence`, soft TTL heartbeat, Mine overlay until that room node is shared; public-room presence HAM-merges through the same-origin `/gun` seed peer), **Public / Mine / Network / Granted** tabs, Check on those post objects, **explicit share-into-mesh** of an admitted native post, room node, or pulled public-source item, **honest unshare** of those prior shares (HAM tombstone / claim republish; not instant everywhere; not a grant revoke), a **tags-first then recency** ranker, a **Discover** browse of tags already on Public (seed + shared rooms) and the live Network mesh (plus a quiet shared-user provenance line), a browser Gun that **tries the same-origin `/gun` seed peer** over WebSocket, and **`gun/lib/webrtc` with STUN-only ICE** (`stun:stun.l.google.com:19302`) so two browsers can exchange mesh traffic when ICE works. Check is **grants**, not login. A see-grant is **not** share-into-mesh and **not** login. Delivery is the holder put onto the accessor inbox — not a public share and not a REST `/api/deliver`. Holding a claim is **not** publishing it. Sharing a room is **not** sharing every Mine post inside it. Granting a room delivers the room node, not the posts, chat, or presence inside it. Chat in a visible room is the live thread for that room — it is **not** dumping Mine posts. Presence is who is in that room now — it is **not** WebRTC. STUN is **not** TURN. If WebRTC fails, the feed falls open to the seed peer / snapshot like today. **Network** reads the live shared graph from Gun `.map().on` on `s3rch/items` and `s3rch/rooms` (seed peer and/or WebRTC when up). It does **not** take snapshot hydrate, Mine overlay, ingest, unshared native posts, or the grant inbox. **Granted** reads only `s3rch/granted/<session>` after SIWE. Discover is **not** search and **not** Popular/Novel. Mine overlay is **not** public discovery. Granted is **not** Discover. Empty Network when the seed socket is down and no mesh rows are in memory: *Network needs the seed peer or WebRTC; Public still has the snapshot*. Empty Granted when the seed socket is down and no inbox rows are in memory: *Granted needs the seed peer or WebRTC; revoke is still immediate on the dest ACL*. Privilege-up / first delivery can wait (mesh delay). Privilege-down (`cancelSee`) is immediate on dest ACL; the inbox tombstone can wait. It still does **not** ship TURN, meetings, live streams, a KYC/passport product, email/SMS verify, uniqueness proofs, ENS/Unstoppable/fname/Lens/RSS3-as-login, outbound bridges, Popular/Novel, an invented search API, `/api/users`, `/api/unshare`, `/api/deliver`, or durable disk archive. Unshare is a client Gun tombstone / republish — not an Azure delete API. Delivery does not write or resurrect those public paths. Snapshot `GET /api/feed` hydration stays **Public** bootstrap — not a Network API and not a delivery API. Chat and presence are Gun `.on` / map, not a hosted transcript or presence server. If the `/gun` socket is down, chat, presence, and first grant delivery can be empty or local only. Presence is not in the snapshot. The live `/feed` copy stays a lab prototype and does not claim a finished P2P mesh, KYC, uniqueness, or outbound bridges. Direct browser-to-source still fails CORS — `/api/ingest` is the proxy, not a second datastore. This slice **architects** durable graph + TURN (requirements only): [durable-graph-and-turn.md](durable-graph-and-turn.md). It does **not** deploy coturn, mount a disk, or put TURN secrets on live ICE.

## Public visual brand (2026-09-08)

Landing, `/feed`, and shared header/footer follow FyberLabs/hypermesh-docs `brand.md`. Locked roles: Ground `#0E0F0C`, Ink `#E8E6DC`, Signal `#F5C400`. Recursive (not Inter). Axes are `data-ground=dark|light` (Dark / Paper) and `data-reader=human|ai` (Human / AI) on shared chrome — not four themes. AI mode is tables-first. Amber is identity, not status. Green/red stay pass/fail only. Odoo and GitLab stay vendor-released. Do not invent hex. Visual only; this file's Gun / SIWE / Check locks are unchanged.

## Steering locks (2026-09-02)

These stay put. They are why the stack looks like this — not a slogan.

1. **Server footprint stays low or none.** Gun was chosen so s3r.ch (and sibling apps) can be full client graphs — browser or a downloadable / hostable app copy. The graph lives with the clients. Azure App Service is a bootstrap seed / cache, not the product database and not the chat or presence server. End-state: TURN-class relays only. Do not grow App Service into a social origin server.

2. **Open protocol, client P2P.** Same spirit as Mastodon / ATProto — except the live graph is client P2P (Gun HAM-merge), not a farm of origin servers. Crypto (SIWE address, Check grants, later payments) extends that. It does not recentralize the graph onto our Azure.

3. **Strong object / API versioning.** Hostable and downloadable copies have to interoperate as the product evolves. GunFeedNode, GunRoomNode, and GunUserNode carry a numeric `v`. This slice writes **`v: 1`**. Missing `v` on old seed rows still reads (treat as v1). Unknown future versions fail closed (`fromGunNode` / `fromGunRoomNode` / `fromGunUserNode` return null) — drop that node, not the whole feed. Sharing between app copies is this versioned Gun shape, not an undocumented JSON dump. Do not invent a REST versioning matrix or a central API host.

4. **Oracles and validators from the browser when possible.** Prefer browser-direct verification (already: SIWE ecrecover, ERC-1271, ENS reverse+forward). Any service we still have to run should look like a crypto validator / relay (seed, TURN, later paid access), not a privileged social backend.

5. **Needed services live in Panopticon.** Same pattern as Hypermesh on Panopticon: an open product network with public APIs so others can run or sell equivalents in a market. Do not grow s3r.ch Azure into that service. Do not invent a second control plane. Azure is not the Gun datastore. Hypermesh Phase 1 Stripe / Keycloak locks stay in hypermesh-docs; this file does not move them. The SociACL crate stays in [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL). This PR does not implement Panopticon, TURN, payments, or oracles. An optional **time-boxed** infra coturn (path B) is allowed only with the **same TURN/URI contract** as the Panopticon product and a **DNS/config cutover** — not a permanent second plane. See [durable-graph-and-turn.md](durable-graph-and-turn.md).

6. **Payments later.** Access to content / connections will be crypto. A thinner fiat micropayment rail (us or others) is optional later. Not this PR. No Stripe, no token launch, no paywall UI.

## End-state vs this slice

| | Now (this PR) | Next / end-state |
| --- | --- | --- |
| Who pulls Farcaster, ATProto, RSS, ActivityPub, Nostr, and optional RSS3 | Lab seeder on the container **and** signed-in browsers through `/api/ingest` (same documented sources). Admit `GunFeedNode` `v: 1` onto Mine. Empty/failed sources write nothing. Direct browser-to-source still fails CORS | Same. Relay / extension later. Do not invent a second proxy or datastore |
| Where the graph lives | Server Gun + JSON snapshot on **ephemeral** container disk; client Gun hydrates from `GET /api/feed` and peers same-origin `/gun` when the socket is up. Recycle empties radisk + snapshot. Browser Gun is `localStorage: false` | HAM-merged mesh is the archive. Optional lab Blob of the **existing** Public snapshot only. App Service disk stays not the archive. See [durable-graph-and-turn.md](durable-graph-and-turn.md) |
| Azure App Service | Seed peer + bootstrap cache so the graph is not empty | Still a seed peer — **not** the realtime / chat / presence server |
| Identity | SIWE cookie session binds a checksummed address (EOA or ERC-1271 smart account). After auth, mainnet ENS, Polygon Unstoppable, plus Farcaster / Lens / RSS3 are held claims on `/feed` when bidirectional public lookups match (not login). **This slice** assembles/updates the Mine overlay `GunUserNode` with those linked claim ids after SIWE + successful lookups (local graph / dest ACL — not session-display-only). Public `s3rch/users/<wallet>` still requires an explicit share of the node or of one claim. Owner can unshare the user node (tombstone) or one claim (republish without that indicator). Overlay can still pull `GET /decentralized/{account}`; items already carry `author` / `provenance` | Same user node, HAM-merged. **Still later:** email/phone / third-party KYC attestations |
| Visibility | Light Check see-grants on the lab dest ACL (memory / IndexedDB) **and** mesh `MeshSeeGrant` rows on `s3rch/acl/<owner>/<aclKey(object)>/<accessor>` so peers can `checkSee` the HAM-merged graph at now. hopcap 1. Optional Social Light `HopFactor` may factor an already-named grant or owner path — hop missing does not fail; hop alone never allows; hop never mints. Public seed is still lab lists plus **explicitly shared** native posts and **explicitly shared** pulled public-source items. Shared rooms live on client `s3rch/rooms`, not the seed snapshot. Shared user nodes live on client `s3rch/users`, not the seed snapshot. A grant is not share-into-mesh. **Delivery** of a granted Gun-stored object is a holder put onto `s3rch/granted/<accessor>` (Granted tab). URL fetches stay handoffs. Chat / presence are not grant-delivered. Browser pulls stay Mine until share | Same Check on **Gun-stored** objects across the mesh. URL fetches stay handoffs. Durable graph + TURN: [durable-graph-and-turn.md](durable-graph-and-turn.md) (docs; not deployed) |
| Streaming, chat, sharing | Native compose + rooms as Gun threads + **live chat** (`GunChatNode` on `s3rch/rooms/<id>/chat`) + **presence** (`GunPresenceNode` on `s3rch/rooms/<id>/presence`, heartbeat ~25s, expire ~75s, admit + Check, Mine overlay until the room is shared) + explicit share-into-mesh of an admitted GunFeedNode onto `s3rch/items`, GunRoomNode onto `s3rch/rooms`, or GunUserNode onto `s3rch/users` + **honest unshare** (HAM tombstone `unshared: 1` / `v: 1` on the same path; claim unshare republishes without that indicator) + **`gun/lib/webrtc`** (STUN-only ICE). No TURN, meetings, or streams | TURN when NAT blocks STUN: **Panopticon end-state**; optional time-boxed infra coturn with the **same URI contract** and DNS cutover. Not WG/Tailscale for browsers. Meetings / streams later. Not a hosted chat or presence server |
| Tabs | **Public** (snapshot hydrate + shared posts / rooms), **Mine** (overlay + native + owned rooms + admitted browser pulls), **Network** (live Gun `.map().on` on `s3rch/items` and `s3rch/rooms`; empty if the seed peer is down and no mesh rows are in memory), **Granted** (live `s3rch/granted/<session>` after SIWE; empty if the seed peer is down and no inbox rows are in memory). **Discover** lists tags already on Public and that live Network mesh (inventory counts + matching shared rooms) and a quiet line of **shared** user nodes (truncated address / indicators). Mine overlay and Granted are not Discover sources. Readers drop unshared public rows when they observe the tombstone | Users do not dump every pull into the public seed by default (already this slice). Unshare tombstones hide retracted public puts (delivery must not resurrect them). Meetings / streams later. Durable graph + TURN architected in [durable-graph-and-turn.md](durable-graph-and-turn.md) |

The lab seeder and `GET /api/feed` are a **bootstrap cache**. They exist so first paint is not an empty graph and so App Service does not have to be the chat or presence server.

```
now:
  lab seeder → server Gun (seed peer) → GET /api/feed snapshot → client Gun
  browser Gun listen-then-opt same-origin /gun — seed peer (ws) when hi fires
  gun/lib/webrtc after gun/browser (STUN-only ICE) — attempted; fall open if ICE fails
  snapshot hydration if the /gun socket is down — fail open
  user overlay → POST /api/ingest (CORS proxy) → Mine only (not public seed)
  signed-in allowed-source pull → POST /api/ingest { allowedSource } → admitFeedNode → Mine (v: 1)
  explicit share-into-mesh (pulled items) → admit again → gun.get('s3rch').get('items') put
  native compose → admitFeedNode → Mine overlay
  compose room → admitRoomNode → Mine rooms list
  explicit share-into-mesh (post) → admit again → gun.get('s3rch').get('items') put
  explicit share-into-mesh (room) → admit again → gun.get('s3rch').get('rooms') put
  assemble user node → admitUserNode → Mine overlay (held claims linked after SIWE lookups; not a public put)
  explicit share-into-mesh (user node / claim) → admit again → gun.get('s3rch').get('users').get(wallet) put
  shared users subscribe → .map().on on s3rch/users (empty if /gun is down; not the snapshot)
  room posts belong by tag (`room:{slug}`); sharing a room does not share its Mine posts
  room chat → admitChatNode → Mine overlay until that room is on s3rch/rooms
  public room chat → admit again → gun.get('s3rch').get('rooms').get(id).get('chat') put
  room chat subscribe → .map().on on that chat path (empty/local if /gun is down)
  room presence → admitPresenceNode → Mine overlay until that room is on s3rch/rooms
  public room presence → admit again → gun.get('s3rch').get('rooms').get(id).get('presence') put
  room presence subscribe → .map().on on that presence path (empty/local if /gun is down)
  Network tab → live Gun .map().on on s3rch/items and s3rch/rooms (not snapshot, not Mine overlay)
  unshare (post / room / user node) → own-only confirm → HAM tombstone { id, unshared: 1, v: 1 } put on the same path
  unshare (one claim) → republish s3rch/users/<wallet> without that indicator
  readers → fromGun* drops unshared / unknown v; Public / Network / Discover hide the row when the put is observed
  grant see → dest ACL (IndexedDB immediate) + MeshSeeGrant put on s3rch/acl + holder put onto s3rch/granted/<accessor>/{items|rooms|users}
  Granted tab → live Gun .map().on on that accessor inbox after SIWE (not Public, not Network)
  revoke see → dest ACL cancel immediate + inbox tombstone (mesh retract can wait)

next:
  durable graph + TURN are architected (docs only) — [durable-graph-and-turn.md](durable-graph-and-turn.md)
  do not deploy coturn, Blob, or live ICE secrets in this slice
  operator: App Service WebSockets + HTTP/2 (sibling infra PR)
  share-into-mesh stays explicit; personal overlay stays mine until shared
  meetings / streams — not this slice
```

## Graphs: public cache, personal overlay, share-into-mesh, unshare, grant delivery

Do not dump every user pull into the public seed by default.

| Graph | Who writes | This slice | Later |
| --- | --- | --- | --- |
| **Public cache** | Lab seeder (Farcaster hub FIDs, ATProto AppView, RSS/Atom, ActivityPub outbox, Nostr kind 1; RSS3 GI optional) | Yes. Snapshot + server Gun. Browsers may HAM-merge the same item shape onto `s3rch/items` only after explicit share of a pull | Seed peer still caches; more peers can merge the same ids |
| **Personal overlay** | The user, in their browser | Yes. Same item shape. Ingest + native posts + **signed-in allowed-source pull**. **Mine** tab. Stays local | Still not public unless they share |
| **Share-into-mesh** | User chooses to publish an **admitted** native post onto `gun.get('s3rch').get('items')`, an **admitted** pulled public-source item onto that same path, an **admitted** room node onto `gun.get('s3rch').get('rooms')`, or an **admitted** user node / selected claims onto `gun.get('s3rch').get('users')` | Wired for own native posts, own rooms, own user node / claims, and admitted browser pulls (confirm + put). Room share ≠ post share. User-node share ≠ dumping every held claim. A pull is not an automatic public put. **Network** reads live item/room puts (and the seed graph) via Gun subscriptions. Shared users are a quiet Discover provenance line, not a Popular list. Not OutboundAdapter. No `/api/users` | Overlay ingest still stays mine unless a later share lands |
| **Unshare / HAM-delete** | Owner retracts a prior share with a `v: 1` tombstone (`unshared: 1`, content fields HAM-nulled) on the same path, or republishes a user node without one claim | Wired, own-only, confirm + client Gun put. Readers drop or hide when they observe the put. Unknown future `v` / unknown `unshared` values fail closed. Room unshare ≠ deleting Mine posts inside; public chat/presence then become local or empty for those readers. Observation **can wait** (privilege-up / mesh delay). Check revoke stays dest ACL and is immediate — grant ≠ share ≠ delivery ≠ unshare. No `/api/unshare` | Stale peers can still hold the old node until they merge. Do not claim instant global delete |
| **Grant delivery** | Holder puts an admitted Gun-stored object onto `gun.get('s3rch').get('granted').get(accessor)` after dest Check allows `see` at now | Wired for native posts, room nodes, and user-node / named claims. Accessor **Granted** tab after SIWE. hopcap 1. Privilege-down immediate on dest ACL; first delivery can wait. URL fetches, chat, and presence are not delivered. Browser pulls stay handoffs until dest admit; they are not grant-delivered. Does not write Public / Network and must not resurrect unshared public rows. No `/api/deliver` | Inbox can wait on the mesh. A durable seed may cache it; dest ACL revoke stays immediate. TURN helps peers see the put. See [durable-graph-and-turn.md](durable-graph-and-turn.md) |

`FeedTab = "public" | "mine" | "network" | "granted"` — Public, Mine, Network, and Granted render. Public keeps snapshot hydrate + shared. Network is the live shared mesh view (seed peer / WebRTC). Granted is the live see-grant inbox (`s3rch/granted/<session>`). Discover browses tags already on Public and that live Network corpus, plus shared user-node provenance when those nodes are on `s3rch/users`. Mine and Granted are not Discover sources. Same FeedItem / Room shapes and tags-first ranker. No `/api/network`. No `/api/users`. No `/api/deliver`.

Observing a wallet's **public** traces is not the person controlling that wallet dumping private overlay into the public cache. Mine vs public vs explicit share still holds for identity the same way it holds for feed items.

## Identity (KYC alternative that stays in crypto)

A s3r.ch user is **not** an email/password account and **not** government KYC. It is an identity graph assembled from public crypto traces — the same lean as RSS3 and other web3 work that looks for solid KYC alternatives without leaving crypto.

This is **not** AML or legal KYC, **not** PII collection, and **not** "verified human" theater. We do not claim sybil resistance or uniqueness proofs. We do not invent a token or a fake passport product. This slice ships SIWE (EOA + mainnet ERC-1271 / EIP-6492) + a cookie session on `/feed`, plus mainnet ENS / Unstoppable / Farcaster / Lens / RSS3 held claims after that session exists, plus light Check see-grants (not login). Coinbase Smart Wallet is an **onramp** (passkey smart account, then SIWE) — not a second IdP and not email login. WalletConnect is a wagmi connector **gated** on `NEXT_PUBLIC_WC_PROJECT_ID` (empty keeps injected + Smart Wallet, no WalletConnect; it is not a new IdP). It does not ship ENS/Unstoppable/fname/Lens/RSS3 as login, a KYC form, or a passport upload. s3r.ch does **not** use Panopticon Keycloak as an IdP. Login rules live in [identity.md](identity.md). Hypermesh portal stays Keycloak; this kit is s3r.ch login and later a Hypermesh wallet door.

### What a user is

We build a user from the wallets and other **public indicators we can actually pull**.

| Role | Source | This slice |
| --- | --- | --- |
| **Primary key** | Wallet address(es) | SIWE session subject is the checksummed address (EOA or ERC-1271 contract). Gun user node is `s3rch/users/<wallet>` after SIWE (Mine until explicit share). Overlay already accepts an RSS3 account (hex / `name.eth`) |
| **RSS3 account path** | Documented `GET /decentralized/{account}` | Wired as personal overlay ingest |
| **ENS / name.eth** | Mainnet reverse + forward after SIWE (`getEnsName` then `getEnsAddress`) | Held claim on `/feed` when both match the session address. Not login. Linked on the overlay user node; public Gun only after explicit share. Overlay RSS3 `name.eth` path unchanged |
| **Unstoppable** | Polygon UNS reverse + forward after SIWE (`reverseNameOf` then `crypto.ETH.address`). Optional server-only `UNSTOPPABLE_API_KEY` if on-chain throws | Held claim on `/feed` when both checksum-match. Not login. Linked on the overlay user node; public Gun only after explicit share. Empty key = quiet empty |
| **RSS3 GI activity** | Optional public lists when `RSS3_GI_BASE` resolves; account path for a wallet | Overlay ingest still wired. Public seed skips GI if DNS/HTTP fails. After SIWE, a GI overlay bound to the session address may show as a quiet held claim (not a dumped activity feed) |
| **Farcaster** | Native Hubble HTTP (`castsByFid` on protocol FIDs) | Public seed. After SIWE, custody reverse + FID registry forward is a held claim (fname or `fid:N`). Not Hub login / SIWF. Public Gun only after explicit share |
| **ATProto / Bluesky** | Public AppView author + generator feeds | Public seed. No auth |
| **ActivityPub** | Public actor outbox, first OrderedCollection page | Public seed. Embedded Create/Note only; string IDs skipped. No auth. Not outbound |
| **Nostr** | NIP-01 kind 1 REQ on a documented relay + pubkeys | Public seed. Server-side WebSocket. Browser still uses `/api/ingest`. Not outbound |
| **Lens** | Public Lens GraphQL (`api.lens.xyz`) owned-account reverse + owner forward after SIWE; GI platform lists still optional for the seed | Held claim on `/feed` when both match. Not Lens OAuth / login. Public Gun only after explicit share |
| **On-chain tx / social tags** | `social`, `transaction`, plus `ethereum`, `base`, `farcaster`, `lens` | Already on feed items |
| **Later optional attestations** | Only if a real, pullable source exists | Not invented here. No passport, no token |

No Instagram, TikTok, Facebook, or locked-down X as identity sources — we cannot pull them (see the bridge matrix).

### Same graph, not a second database

Feed items already carry `author` and `provenance`. Identity emerges from the **same cache/mesh**, not a parallel store.

**User node** (this slice): a Gun user node keyed by wallet, with linked indicator ids. After SIWE + verified held-claim lookups, the Mine overlay `GunUserNode` is assembled/updated with those claim ids (local graph + dest ACL). That is Gun-linked held state — not IdentityBar session display. Public graph only after explicit share of the node or of individual claims. This slice writes `v: 1`. Unknown `v` fails closed (`fromGunUserNode` returns null).

```
gun.get('s3rch').get('users').get(wallet)
  { id: wallet, indicators: 'ens:name.eth,rss3:…,farcaster:…', provenance, ts, v: 1 }
```

- Lab seeder already concentrates **public** lists (activity, not a user registry). Azure is still a seed peer — not a user-registry server. No `/api/users`.
- Browsers link **their own** verified held claims (same browser-direct lookups as `/feed` today). Holding ≠ publishing.
- Linking those indicators onto the wallet node is HAM-merge, same as items. Public `indicators` CSV holds only **shared** claims.
- Putting a wallet's public GI traces in the public cache ≠ publishing that person's private overlay. Explicit share-into-mesh still required. Unshare of the user node or of a shared claim is an own-only tombstone / republish — not a grant revoke, and not instant everywhere.

### Held claims (default private)

We can collect **many proof types** onto the same user node. Holding a proof is not publishing it.

| Claim kind | What it is | Default visibility |
| --- | --- | --- |
| Wallets / public crypto indicators | Already: RSS3 account, ENS/`name.eth`, Farcaster hub FIDs, ATProto handles, Lens via GI when up, on-chain tags | Public **lists** the lab seeder already concentrates stay public cache. A holder's **assembled footprint** (all linked indicators) is overlay until **explicitly shared**. A see-grant is not that share |
| Third-party digital KYC attestations | Later, only if a real issuer exists. Not a s3r.ch passport product | **Private** (held claim) |
| Old-school email / phone confirmation | Later. Proves the claim **to the holder** | **Private**. Confirming an email does **not** publish it |

Those last two are supportable end-state, not this slice. This PR has no email/SMS, no KYC vendor, no verify UI. Mesh-wide Check + Social Light hop factor ship; hop UI and KYC do not.

### Visibility is a grant (lighter SociACL Check)

Seeing is a grant. The user decides **who** sees **which** claim and **when** (time-bounded). Nobody else sees the full footprint unless they were granted it. The public mesh only gets **explicitly shared** claims — the same rule as share-into-mesh.

This is a **lighter SociACL Check** on social/identity claims. It is not a new company and not bolting FyberLabs/SociACL (Elect, wills, devices, Case C) onto this Next app. Full SociACL stays outside this repo ([FyberLabs/SociACL](https://github.com/FyberLabs/SociACL)). This Next app **reimplements** the consume contract ([s3rch-check.md](s3rch-check.md)) in TypeScript and runs Check in the browser. Do not import the crate. s3r.ch is the product surface. Public mesh vs mine still applies: a see-grant is not share-into-mesh.

Map, using SociACL language **without importing the crate**:

| SociACL term | On s3r.ch |
| --- | --- |
| Object | Anything **in Gun**: a feed item, a room, or a held claim (wallet indicator, KYC attestation, email/phone confirmation). Not a remote RSS3/KYC JSON blob |
| Accessor | Another wallet / Gun peer |
| Check | `CHECK(see, claim, accessor)` evaluated **at now** |
| Grant | Jointly stated edge: holder and accessor both state it. **hopcap 1** — no friends-of-friends, no transitive “your friend’s grant” |
| Privilege-down | Revoke is **immediate** on the dest ACL. The accessor loses `see` as soon as the grant is gone. That is Check `cancelSee`, **not** mesh unshare |
| Privilege-up | A new or wider grant **can wait** (propagation / mesh delay). Do not pretend it is instant everywhere. **Unshare observation is this class** — peers hide the row when they merge the tombstone; stale peers can still hold the old node |
| Attestation | Email/phone/KYC **issuers** are pre-enrolled verifiers. An attestation proves the claim to the holder. It is **not** a grant. Issuers do not publish the footprint |

```
held claim (overlay, private)
  → CHECK(see, claim, accessor) at now
      grant exists and now ∈ [from, until) → accessor may see that claim
      no grant / expired / revoked          → accessor sees nothing
  → explicit share-into-mesh                → that claim only, on the public cache
  → explicit unshare                        → tombstone / republish without that claim (observed when peers merge)
  → grant delivery (Gun-stored only)        → s3rch/granted/<accessor> (Granted tab)
```

This slice ships light Check see-grants on the lab dest ACL **and** Gun `s3rch/acl` `MeshSeeGrant` rows, plus live mesh **delivery** of granted Gun-stored objects. Optional hop may factor Check; it cannot mint. Live `/feed` must not claim KYC, uniqueness, or hop UI. A grant is not login. Delivery is not share-into-mesh. URL fetches stay handoffs.

## How SociACL meets Gun (locks, 2026-08-31)

These locks stay put. s3r.ch (this repo) is **product / UX**. The full Gun adapter lives in SociACL (SociACL Dev Bot / [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL)). This Next app re-types the light consume contract and runs `CHECK(see, …)` in the browser. This is **not** Hypermesh Phase 1. This Next app does not import the crate, Elect, wills, devices, or Case C.

1. **Gun-stored data is native SociACL.** Feed items, rooms, chat messages, presence heartbeats, and held claims that live in Gun **are** SociACL objects. Light Check applies to dest-ACL objects in this app. Putting a row in Gun is admitting it to that object space — not a reason to skip Check.

2. **Non-Gun external data is URLs.** RSS3 GI, RSS/Atom, KYC issuer APIs, email/phone verifiers: we hold a **URL plus untrusted hints**, not a grant. `permalink` / provenance on a feed item may name that URL. The remote body is not a SociACL object until something we control re-authorizes it into Gun.

3. **Crossing a URL is an edge handoff, not a grant.** `/api/ingest` and the lab seeder fetch are handoffs. Fetching does **not** mint `see`. A successful HTTP 200 from GI or a feed is not `CHECK(see, …)` and does not enroll an accessor.

4. **The destination must not trust our metadata** except untrusted hints: user/agent ID as we consider them, the data we think they are requesting, optional verb/context. The destination **re-authorizes**. When **we** are the destination (ingest or seeder returning into Gun), we re-authorize **before** putting a native SociACL object in Gun. Do **not** copy RSS3 / KYC response fields into a grant.

5. **Social Light hop** can factor a Check; it **cannot mint the grant**. `checkSee(..., hint?, hop?)`. `acceptHop` / `decodeHop` do not verify. No hop UI on public `/` or `/feed`.

```
URL (RSS3 / RSS / ActivityPub / Nostr / issuer)  --handoff-->  fetch
     hints only (untrusted): who we think, what we think they asked, optional verb
     destination re-authorizes
        we are destination → re-authorize → put native SociACL object in Gun
        we are not         → they re-authorize; our hints are not their grant
Check (this Next app, consume contract; full plane stays in SociACL) applies only to Gun-stored / dest-ACL objects
```

## Source of truth (now)

Gun is already the graph. This slice uses a bootstrap path so Azure does not have to serve every subscription.

- Server process holds a Gun instance (radisk on the App Service container disk, plus an in-memory index and a JSON snapshot for restarts).
- `gun-preload.cjs` attaches Gun to the Node HTTP server (`listen` patch, radisk under `/app/data/radata`, WebSocket path `/gun`). That is the **seed peer**, not a finished mesh.
- `/feed` constructs browser Gun with `localStorage: false` and no peers, after a guarded side-effect import of `gun/lib/webrtc` (STUN-only `opt.rtc.iceServers`). It subscribes to mesh hi/bye on `gun._.on`, then `opt({ peers: [same-origin /gun] })` (`lib/gun-peer.ts`) so a live `hi` is not missed. WebRTC `mesh.hi` does not flip **seed peer (ws)** — only a `/gun` URL does. It still hydrates from `GET /api/feed`, then `gun.get(...).map().on(...)`. Snapshot items are painted into React state first so Public is not empty if the socket (or `localStorage: false`) cannot echo those puts. **Network** is a separate live set filled only from those Gun listeners while the seed peer is up (last-seen rows stay after a brief bye). Status says **seed peer (ws)** vs **snapshot only**, plus a quiet **WebRTC attempted (STUN ≠ TURN)** hint when the adapter loaded. That is not a finished P2P mesh. If ICE fails, behavior matches today's seed / snapshot path. Public still has the snapshot; Network does not.
- Shared native posts / rooms / admitted pulled items `put` still go to `gun.get('s3rch')…` after admit. Once the socket is up those puts can reach the seed. Mine until share. A browser pull is not that put.
- If every live source fails, the seeder writes nothing. The feed stays empty. No invented rows. A down RSS3 GI host does not empty Farcaster / ATProto / RSS / ActivityPub / Nostr pulls.

## Honest gates

These are real constraints. Do not paper over them.

1. **Browser CORS.** Farcaster Hubble, ATProto AppView, ActivityPub actors, RSS3 GI, and most RSS/Atom feeds will not load cross-origin from `s3r.ch`. Nostr relays are WebSocket (NIP-01) on the seeder / `/api/ingest` process — browsers still do not talk to those hosts from `/feed`. This slice ships signed-in browser pull **through** `/api/ingest` (same documented seeder sources). Direct browser-to-source still fails. A relay or extension is later. Do not invent a second proxy or pretend CORS is gone. `/api/ingest` does not write the public seed.
2. **App Service WebSockets + HTTP/2.** This slice wires the browser to same-origin `/gun`. Cloudflare already passes `/gun` 101 Switching Protocols and Gun DAM (orange-cloud and straight to App Service); the previous “CF/ARR drop WS” line is not the live diagnosis. Snapshot remains the fallback if the socket dies. No Cloudflare terraform in this repo. This PR enables `gun/lib/webrtc` with STUN-only ICE. It does not claim browsers already mesh. If WebRTC is unavailable or ICE fails, the seed peer / snapshot path is unchanged.
3. **STUN is not TURN.** Google public `stun.l.google.com:19302` is **STUN**, not TURN. Do not document Google as a free TURN server. Do not stand up TURN on App Service. ICE in this slice is STUN only. Requirements and Panopticon-vs-infra: [durable-graph-and-turn.md](durable-graph-and-turn.md). Product end-state stays Panopticon (lock 5). Optional time-boxed infra coturn only with the same URI contract and DNS/config graduation — not a second control plane.
4. **Ephemeral container disk.** The seed peer is a **cache**, not durable storage. A recycle empties radisk and the snapshot until the next seed. Browser Gun is `localStorage: false`, so a refresh does not hold the graph either. Do not treat `/app/data` as the archive. Durable-graph options: [durable-graph-and-turn.md](durable-graph-and-turn.md).

## Durable graph (requirements)

Docs only. Full options, threat/ops, and lab-vs-product pick: [durable-graph-and-turn.md](durable-graph-and-turn.md).

**What survives an App Service recycle today:** dest ACL + SEA wrap in that browser’s IndexedDB. **What does not:** radisk, `snapshot.json`, process memory, browser Gun (`localStorage: false`). The next weekday seed rebuilds **seeder Public items only**. Shared rooms, users, granted inbox, public chat, and presence are gone unless a still-open tab still holds them.

**Do not** grow App Service into a social origin (Files-mounted radisk as the product archive). **Lab:** optional Azure Blob of the existing Public `FeedSnapshot` only — still a cache. Shared graphs stay mesh. **Product:** the mesh is the archive; any durable seed is a Panopticon open relay. HAM tombstones (`unshared: 1`) must travel with a path if that path is persisted. Grant-inbox retract can wait; `cancelSee` stays immediate. Presence is live TTL — do not restore heartbeats as “who is here.” No SIWE / SEA / TURN secrets on Gun.

## TURN (requirements)

Docs only. Full ICE / auth / Cloudflare / A-B-C and Research Bot Azure constraints: [durable-graph-and-turn.md](durable-graph-and-turn.md).

Keep STUN. TURN is for symmetric NAT (and later meetings), not for snapshot hydrate, and not a chat server. No TURN on App Service. Orange-cloud `/gun` WebSocket stays; UDP TURN needs a **DNS-only** hostname. Time-limited credentials; long-lived secret in Key Vault only — never on Gun, never `NEXT_PUBLIC_*`.

**Recommend:** Panopticon end-state (path A) + optional **time-boxed** interim infra coturn (path B) that already implements the **same allocate / ICE URI contract**, so graduation is **DNS/config cutover**, not a second control plane. Azure is not the Gun datastore. Do **not** send s3r.ch browsers through cottage WireGuard or Tailscale (Tailscale stays admin SSH).

If B happens later (not this PR): small dedicated Linux VM (**B2s / B2ms**, **East US 2**), one region, **separate host** from the Gun seeder, public TURN (do not PE-only), NSG UDP 3478 + capped relay range and 443 if TURNS, rate-limit early, no AKS / no gold HA until metrics say so. No product data on the relay.

| Path | Near-term lab | Product end-state | Lock |
| --- | --- | --- | --- |
| **A** Panopticon TURN product (open API, market of equivalents) | Wait, or sit behind the same contract | **Recommended** | Matches lock 5 |
| **B** Time-boxed infra coturn, identical URI contract, DNS cutover | **Optional**, only if every B condition in the design note holds | Retired or one operator of A | Lock **stays** |
| **C** Infra-only forever | Conflicts | Conflicts | Requires amending `open-services.md` — not done here |

This PR does not deploy a relay or change live ICE.

## Item shape

Every item in the public cache, the snapshot, the overlay, and the live mesh uses the same shape:

```ts
{
  id: string          // canonical activity id, guid, or permalink
  source: string      // rss3 | rss | atom | farcaster | atproto | activitypub | nostr | s3rch
  kind: string        // RSS3 tag (social, transaction, …) or rss / atom
  author: string
  body: string
  ts: number          // unix seconds
  permalink: string
  tags: string[]      // kind + platform/network slugs
  provenance: string  // where it was pulled from
  v?: number          // Gun protocol version; this slice writes 1; missing reads as 1
  unshared?: 1 | null // HAM retract. `1` drops the row. Missing / null is live. Other values fail closed
}
```

Gun does not store arrays. On disk / on the wire, `tags` is a comma-separated string. Readers split; writers join.

### Tags

Tags are the filter and engagement primitive for this slice.

- From RSS3: the activity/action `tag` (`social`, `transaction`, …).
- Plus platform / network slugs when present (`farcaster`, `lens`, `ethereum`, `base`).
- From Farcaster hub: `farcaster`, `social`.
- From ATProto AppView: `atproto`, `bsky`, `social`.
- From ActivityPub outbox: `activitypub`, `social`.
- From Nostr kind 1: `nostr`, `social`.
- From public RSS/Atom: `rss` or `atom`, plus `ethereum` / `farcaster` / `social` when the feed is that network.
- Overlay RSS/Atom ingest still adds `user`.
- Native s3r.ch posts add `user` and `s3rch`.
- Rooms add `room` and `s3rch`. Posts in a room also carry `room:{slug}` (stable, from the room id). That tag is membership — not a second foreign-key store.
- Room lists filter by TagChips + recency (`rankRooms`). Room threads reuse `rankFeedItems` on posts that carry the room tag. No search API. No Popular / Novel.
- Deduped, lowercased, no empty strings.
- Filter primitive: TagChips any-match on the **active tab**. Ranker: more matching tags first, then `ts` desc. No engagement scores. No Popular / Novel columns.
- **Discover** (`lib/feed-discover.ts`) is a client-side browse of tags already on Public (snapshot + shared rooms) and the live Network mesh (`meshItems` / `meshRooms` from Gun `.map().on`). It does **not** ingest Mine overlay, Granted inbox rows, or unshared native posts as public discovery. Counts are inventory (how many items / rooms carry the tag), sorted alphabetically — not an engagement score and not a Popular column. Clicking a tag uses the same any-match ranker. Matching shared rooms show a short owner snippet (provenance, not a user profile). Shared user nodes from `s3rch/users` may show as a quiet provenance line (truncated address + shared indicators) — not a Popular list and not Mine overlay. Optional `/feed?tag=` deep-link selects those tags. No `/api/search`, `/api/discover`, `/api/network`, or `/api/users`. Azure App Service is still the seed peer, not a discovery server.

### Item identity and merge

Dedupe key is `id` if present, otherwise the normalized permalink URL.

Same shape everywhere so a browser peer can HAM-merge without a second schema. Provenance names the real URL (`farcaster:hub:…`, `atproto:…`, `activitypub:{outbox}`, `nostr:relay:…`, `rss:{url}`, `atom:{url}`, `rss3:gi:…`). `author` is a public indicator (handle, owner, from), not a logged-in account.

Locked Gun paths (do not fork):

```
gun.get('s3rch').get('items').get(encodeKey(id))   → GunFeedNode
gun.get('s3rch').get('rooms').get(encodeKey(id))   → GunRoomNode
gun.get('s3rch').get('rooms').get(encodeKey(id)).get('chat').get(encodeKey(mid)) → GunChatNode
gun.get('s3rch').get('rooms').get(encodeKey(id)).get('presence').get(encodeKey(address)) → GunPresenceNode
gun.get('s3rch').get('users').get(wallet)          → GunUserNode (write after explicit share)
gun.get('s3rch').get('granted').get(accessor).get('items'|'rooms'|'users').get(encodeKey(id))
                                                   → grant-delivery envelope (v: 1; not a public row)
gun.get('s3rch').get('acl').get(aclPrincipalKey(owner)).get(aclKey(object)).get(aclPrincipalKey(accessor))
                                                   → MeshSeeGrant (stated 1|0; not a Check object)
gun.get('s3rch').get('meta')                       → seed meta, not a Check object
```

A room is `{ id, title, owner, tags, ts, provenance, v }` with csv tags on the wire. A chat message is `{ id, room, author, body, ts, v }`. A presence heartbeat is `{ room, address, ts, v }` (no held claims, no signatures). A user node is `{ id, indicators, provenance, ts, v }` with csv indicators on the wire (claim ids such as `ens:name.eth`). This slice writes `v: 1`. Missing `v` reads as v1. Unknown future `v` fails closed (`fromGunNode` / `fromGunRoomNode` / `fromGunChatNode` / `fromGunPresenceNode` / `fromGunUserNode` / `fromGrantDeliveryNode` return null). An unshare tombstone is `{ id, unshared: 1, ts, v: 1 }` with leftover content fields HAM-nulled. A present `unshared` that is not `null` fails closed (readers drop). Re-share puts `unshared: null` so HAM can clear the marker. Grant-deliverable objects are Gun-stored native posts, room nodes, and user-node / named claims. URL fetches stay handoffs. Chat and presence are not grant-delivered. The grant inbox is not written into the public seed / snapshot. Delivery must not resurrect unshared public rows. Do not put SIWE signatures or SEA `priv` / `epriv` on a grant envelope. Room object id for Check is the room id / `s3rch/rooms/<encodeKey(id)>`. Chat object id is `s3rch/rooms/<encodeKey(room)>/chat/<encodeKey(id)>`. Presence object id is `s3rch/rooms/<encodeKey(room)>/presence/<encodeKey(address)>`. User object id is `s3rch/users/<wallet>`. Claim object id is the claim id, linked from the user node — do not invent `s3rch/users/{wallet}/claims/…`. Rooms, room posts, room chat, room presence, and user nodes are **not** written into the public seed / `GET /api/feed` snapshot / lab seeder. Public rooms are client Gun `s3rch/rooms` after an explicit share. Public user nodes are client Gun `s3rch/users` after an explicit share. Chat and presence on a Mine-only room stay overlay until that room node is shared. Unsigned visitors can read public-room chat and presence when the room node is on the public graph, and can read a **shared** user node; they do not see a private footprint. SIWE is required to send chat, announce presence, or write a user node. Do not put SIWE signatures or SEA `priv` / `epriv` on the chat, presence, or user node.

## Public seeder (bootstrap cache)

Fetching a URL is an edge handoff, not a grant. Empty or failed sources write nothing. `POST /api/seed` is **503** only when `sourcesOk=0` **and** there is an error. A dead GI host must not empty the other sources. Signed-in browsers can pull the **same** documented classes via `POST /api/ingest` `{ allowedSource }`. That route still does **not** write the public seed — the client admits `v: 1` onto Mine and only puts `s3rch/items` on an explicit share.

User-Agent: `s3r.ch-gun-feed/0.1 (Fyber Labs)`. Timeouts are 8s, same as the old GI fetches.

### Farcaster Hubble HTTP (required for a live seed)

Default hub: `https://hub.pinata.cloud` (override `FARCASTER_HUB_BASE`). No API key.

Probed 2026-09-01:

- `GET /v1/info` → 200
- `GET /v1/castsByFid?fid=1&pageSize=20&reverse=true` (also fid=2, fid=3) → 200 with messages
- `reverse=1` is **400**; the query must be `reverse=true`

Channel parent URLs returned **empty** messages (`warpcast.com` and `farcaster.xyz` `/~/channel/ethereum`, `/~/channel/farcaster`, and documented FIP-2 `chain://eip155:7777777/erc721:0x00000000fcb935a5ba12c7d4c0d1f0d71538b39c`). We do **not** seed empty channels.

Public seed uses a small documented list of public protocol FIDs that responded with casts: **1** (`farcaster`), **2** (`v`), **3** (`dwr`).

Hub `data.timestamp` is seconds since the Farcaster epoch **2021-01-01 UTC = 1609459200**. Convert to unix seconds by adding that offset. Verified against fid=2 cast `0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a`: hub ts `156796112` → unix `1766255312` (`2025-12-20T18:28:32Z`). Treating the hub ts as unix lands in 1974.

Provenance: `farcaster:hub:{hub}/v1/castsByFid?fid={fid}`.

### ATProto public AppView (no auth)

Default: `https://public.api.bsky.app` (override `ATPROTO_APPVIEW_BASE`). No Neynar or other API-key services.

Documented public set, probed 200 on 2026-09-01:

- `GET /xrpc/app.bsky.feed.getAuthorFeed?actor=ethereum.bsky.social&limit=20`
- `GET /xrpc/app.bsky.feed.getFeed?feed=at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot&limit=20`

Provenance: `atproto:{url}`.

### ActivityPub inbound (actor outbox)

Documented public actors (allowlist, not a search API). Probed 200 unsigned on 2026-09-09:

- `https://w3c.social/users/w3c` → outbox first page embeds Create/Note
- `https://fosstodon.org/users/Fosstodon` → outbox first page embeds Create/Note

`mastodon.social` (and some other hosts) return **401 Request not signed** (authorized fetch). This slice does **not** implement HTTP Signatures. Azure is not an ActivityPub server. Those hosts stay off the allowlist.

Pull is actor JSON (`Accept: application/activity+json`) → `outbox` → first OrderedCollection page only. Embedded `Create`/`Note`/`Article` objects become FeedItems. String IDs and `Announce` rows are skipped (not fetched, not invented). Followed `outbox` / `first` URLs pass `assertPublicHttpUrl`. Empty or failed actors write nothing.

Provenance: `activitypub:{outbox}`.

Outbound ActivityPub posting is not wired.

### Nostr inbound (kind 1 relay query)

Default relay: `wss://nos.lol` (override `NOSTR_RELAY_URL`). NIP-01 `REQ` with `{ kinds: [1], authors, limit: 20 }`. Server-side WebSocket on the seeder / `/api/ingest` process. Browsers still go through the same-origin proxy. `wss://relay.damus.io` timed out from this lab network on 2026-09-09 — a dead relay writes nothing.

Documented public hex pubkeys:

- `3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d` (fiatjaf)
- `82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2` (Jack Dorsey)

Kind 0/3/7 and other events are skipped. Permalink is `https://njump.me/{id}` (viewer, not a second datastore). Empty or failed relays write nothing.

Provenance: `nostr:relay:{relay}?kinds=1&authors={pubkey}`.

Outbound Nostr posting is not wired.

### RSS / Atom

Parser in `lib/rss-atom.ts` (`MAX_ITEMS` 30). Follow redirects.

- `https://blog.ethereum.org/en/feed.xml` → 200 RSS (`/feed.xml` 301s)
- `https://github.com/farcasterxyz/protocol/commits/main.atom` → 200 Atom

No Instagram / TikTok / Facebook / X.

Provenance: `rss:{url}` or `atom:{url}`.

### RSS3 GI (optional extra)

Documented GI base: `https://gi.rss3.io` ([RSS3 Data Sublayer API](https://docs.rss3.io/guide/developer/api)).

**`gi.rss3.io` currently has no public DNS** (no A / AAAA / CNAME; confirmed 2026-08-31 and 2026-09-01 via Cloudflare and Google DoH). Keep `lib/rss3.ts`. If `RSS3_GI_BASE` fails DNS or HTTP, count it as a failed source and continue.

When the host works, public seed still pulls only these documented list endpoints:

| Path | Query |
| --- | --- |
| `/decentralized/network/ethereum` | `tag=social` |
| `/decentralized/network/ethereum` | `tag=transaction` |
| `/decentralized/network/base` | `tag=transaction` |
| `/decentralized/network/farcaster` | `tag=social` |
| `/decentralized/platform/Farcaster` | `tag=social` |
| `/decentralized/platform/Lens` | `tag=social` |

A user's RSS3 address overlay uses the documented account path:

`GET /decentralized/{account}`

No search-query API. No invented GI routes.

Cadence:

- `POST /api/seed` with `Authorization: Bearer $SEED_SECRET` writes into Gun.
- GitHub Action `.github/workflows/seed.yml` on a weekday-hours cadence (and `workflow_dispatch`) hits that route on the live container.
- In production, a missing secret refuses the seed. Locally, an unset secret is allowed so the container can hit itself.
- The Action prints HTTP status and response body on non-2xx (still fails the job). It does not log `SEED_SECRET`. A missing secret still skips green (`exit 0`).

## Azure / process shape

The site is a Next.js standalone container on Azure App Service (port 8080). There is no second Azure service and no Terraform in this repo. App Service is a **seed peer + bootstrap cache**, not the chat or presence server.

The container runs Next's standalone `server.js` with `node -r ./gun-preload.cjs`:

1. Preload patches `http.Server.prototype.listen` and attaches Gun (`web: server`, radisk under `/app/data/radata`, WS path `/gun`).
2. The process listens on `PORT` / `HOSTNAME` (8080).
3. `/feed` still paints from `GET /api/feed` if the `/gun` WebSocket is down. The client tries the seed peer and attempts `gun/lib/webrtc` (STUN only); snapshot if the socket is down or ICE fails.

`/api/health` stays `{ "status": "ok" }` for the existing Deploy smoke test.

## In / out bridge matrix

Most social networks are walled gardens. This table is the honest matrix. **Yes** means the network actually exposes a pull or post API we could use. **No** means we will not pretend.

| Network | Pull in | Repost out | This slice |
| --- | --- | --- | --- |
| RSS3 Data Sublayer | yes | yes (GI write is not used here) | optional public seeder + address ingest + signed-in `rss3-gi` pull; `gi.rss3.io` currently has no DNS |
| RSS / Atom | yes | yes (feed file / ping) | public seeder + URL ingest + signed-in documented-feed pull, same-origin proxy |
| ActivityPub | yes | yes | public seeder + signed-in browser pull via actor outbox first page; `/api/ingest` CORS proxy. Outbound not wired |
| ATProto / Bluesky | yes | yes | public seeder + signed-in browser pull via AppView (no auth); `/api/ingest` CORS proxy |
| Nostr | yes | yes | public seeder + signed-in browser pull via NIP-01 kind 1 REQ (server WS); `/api/ingest` CORS proxy. Outbound not wired |
| Farcaster | yes (Hub HTTP + GI) | yes (where APIs exist) | public seeder + signed-in browser pull via Hubble HTTP (Pinata, no API key); `/api/ingest` CORS proxy |
| Lens | yes (GI + Lens API) | yes (where APIs exist) | pull via RSS3 GI only (GI optional / currently no DNS) |
| Instagram | no | no | none |
| TikTok | no | no | none |
| Facebook | no | no | none |
| X (locked-down) | no | no | none |

Outbound: `OutboundAdapter` is an interface only. Native s3r.ch compose is **not** a Farcaster / ATProto / RSS bridge. Nothing claims posting-to-those-networks works.

## Later (not this follow-up)

- App Service WebSockets + HTTP/2 are already on. The client listens for mesh `hi` before opening `/gun`. Do not change Terraform in this repo.
- TURN so NAT'd peers can mesh when STUN cannot punch. Architected in [durable-graph-and-turn.md](durable-graph-and-turn.md) (not deployed). Google STUN ≠ TURN. No TURN on App Service. Product end-state is Panopticon (path A). Optional time-boxed infra coturn (path B) only with the same URI contract and DNS/config cutover.
- Meetings / streams. Unshare tombstones hide retracted public puts — grant delivery must not resurrect those public rows. Network tab **does** ship (live Gun subscriptions; Discover reads that corpus). Granted tab **does** ship (grant inbox; not Discover). Gun user node + explicit claim share **do** ship. Unshare / HAM-delete **does** ship (client tombstone; not instant global delete). Live mesh **delivery** of granted Gun objects **does** ship. Signed-in **browser pull** of allowed sources through `/api/ingest` **does** ship (Mine until share; HAM-merge on explicit share). Direct browser-to-source still fails CORS. Not a finished P2P mesh claim.
- Wire the SEA pair (not `recall` to sessionStorage) and PRF wrap after SIWE is proven — already this kit. Do not put `priv` / `epriv` on the user node.
- Mesh-wide Check on Gun `s3rch/acl` **does** ship (plus lab IndexedDB for immediate privilege-down). URL fetches remain handoffs; they do not mint `see`. Not Hypermesh Phase 1. Social Light hop can factor a Check; it cannot mint a grant. No hop UI. Email/phone KYC still later.
- Email/phone confirmation and third-party KYC attestations as private claims (prove to holder ≠ publish).
- Meetings and live streams. Chat and presence over Gun subscriptions on a visible room **do** ship; they are not WebRTC. `gun/lib/webrtc` + STUN **does** ship; it is not a meeting or stream product.
- ActivityPub / Nostr / Farcaster / ATProto **outbound** posting (inbound pull for those networks is wired; posting is not). A browser extension CORS bypass is a different PR.
- Durable storage is the mesh (and any later durable seed), not the container disk. Requirements: [durable-graph-and-turn.md](durable-graph-and-turn.md). This PR does not mount Blob/Files or a relay VM.
- TURN-class relay, Panopticon-hosted needed services, oracles/validators, and crypto (or later fiat) payments — see **Steering locks**. None of those are implemented in this PR. Durable graph + TURN are architected only.

## Out of scope (do not restore)

- Public `/research` and plantuml.com embeds. `session-uc.wsd` / `group-uc.wsd` stay in git, unlinked.
- Popular vs novel columns.
- Invented GI or search APIs, token, protocol pages, or `/api/users`.
- 2019 session/group contracts and tokenomics.
- Azure OIDC / Deploy secrets.
- Deploying TURN, meetings, live streams, or hop UI in this slice. Rooms as Gun threads plus live chat and presence over Gun subscriptions are this slice. The Network tab reads that live graph; it is not a finished P2P mesh product. Presence is not a TURN/WebRTC mesh. `gun/lib/webrtc` + STUN ships; TURN requirements are documented, not deployed.
- ENS / Unstoppable / fname / Lens / RSS3 as login, Farcaster SIWF, KYC form, passport upload, email/SMS verify, or claims of legal KYC / sybil resistance / uniqueness. WalletConnect is gated on `NEXT_PUBLIC_WC_PROJECT_ID` (see [identity.md](identity.md)); do not invent a project id.
- Importing the SociACL Rust core into this Next app, or exposing Elect / wills / devices / Case C on s3r.ch.
- Treating a seeder or `/api/ingest` fetch as a grant, or copying RSS3/KYC fields into a grant.
- A hop UI, Elect / wills / Case C, or claiming uniqueness / KYC / full mesh ACL already works on live `/feed`.
