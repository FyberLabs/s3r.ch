# s3r.ch architecture (2026-09-02)

Internal notes for the lab prototype. This is not a public `/research` route, not a protocol spec, and not tokenomics.

s3r.ch is a Fyber Labs lab site. **Gun is the graph.** RSS3 Data Sublayer activity and other allowed sites / crypto-social sources concentrate on that graph. Popular items cache across peers. The same graph is the unique real-time streaming / chat / sharing network — **mostly browser-to-browser**, not a chat server we host.

This slice **does** ship EIP-4361 SIWE login (EOA ecrecover plus mainnet ERC-1271 / EIP-6492 for smart accounts), a signed cookie session, mainnet ENS / Unstoppable / Farcaster / Lens / RSS3 held claims after auth, light SociACL **Check see-grants** in the browser (see [identity.md](identity.md) and [s3rch-check.md](s3rch-check.md)), **native s3r.ch posts** (mine by default), **Public / Mine** tabs, Check on those post objects, **explicit share-into-mesh** of an admitted native post, and a **tags-first then recency** ranker. Check is **grants**, not login. A see-grant is **not** delivery and **not** share-into-mesh. It still does **not** ship chat UI, rooms, presence, WebRTC, a KYC/passport product, email/SMS verify, uniqueness proofs, ENS/Unstoppable/fname/Lens/RSS3-as-login, outbound bridges, a working Network tab, or Popular/Novel columns. Snapshot hydration is **now**. The mesh is **next**. The live `/feed` copy stays a lab prototype and does not claim P2P mesh, KYC, uniqueness, or outbound bridges already work.

## End-state vs this slice

| | Now (this PR) | Next / end-state |
| --- | --- | --- |
| Who pulls Farcaster, ATProto, RSS, and optional RSS3 | Lab seeder on the container; `/api/ingest` as a same-origin proxy | Lab **and** users' browsers, writing the same item shape |
| Where the graph lives | Server Gun + JSON snapshot; client Gun hydrated from `GET /api/feed` | HAM-merged mesh. Browsers are Gun peers. Popular items cache across peers |
| Azure App Service | Seed peer + bootstrap cache so the graph is not empty | Still a seed peer — **not** the realtime / chat server |
| Identity | SIWE cookie session binds a checksummed address (EOA or ERC-1271 smart account). After auth, mainnet ENS, Polygon Unstoppable, plus Farcaster / Lens / RSS3 are held claims on `/feed` when bidirectional public lookups match (not login, not written to Gun). Overlay can still pull `GET /decentralized/{account}`; items already carry `author` / `provenance` | Gun user node keyed by wallet, linked **held claims**, HAM-merged like feed items |
| Visibility | Light Check see-grants on the lab dest ACL (memory / IndexedDB), including native post objects. hopcap 1. Public seed is still lab lists plus **explicitly shared** native posts. A grant is not share-into-mesh and is not delivery | Same Check on **Gun-stored** objects across the mesh. URL fetches stay handoffs. Mesh **delivery** of a granted object is later |
| Streaming, chat, sharing | Native compose + explicit share-into-mesh of an admitted GunFeedNode onto `s3rch/items`. No chat | Gun subscriptions on that mesh, mostly peer-to-peer |
| Tabs | **Public** (seed / shared) and **Mine** (overlay + native). Network is type-only | Network tab reads the mesh. Users do not dump every pull into the public seed by default |

The lab seeder and `GET /api/feed` are a **bootstrap cache**. They exist so first paint is not an empty graph and so App Service does not have to be the chat server.

```
now:
  lab seeder → server Gun (seed peer) → GET /api/feed snapshot → client Gun
  user overlay → POST /api/ingest (CORS proxy) → Mine only (not public seed)
  native compose → admitFeedNode → Mine overlay
  explicit share-into-mesh → admit again → gun.get('s3rch').get('items') put

next:
  browsers pull allowed sources → write same item shape → HAM-merge into the mesh
  /gun (+ WebSockets) is a real seed peer
  gun/lib/webrtc so browsers talk when the seed peer is idle
  share-into-mesh is explicit; personal overlay stays mine until shared
```

## Graphs: public cache, personal overlay, later share-into-mesh

Do not dump every user pull into the public seed by default.

| Graph | Who writes | This slice | Later |
| --- | --- | --- | --- |
| **Public cache** | Lab seeder (Farcaster hub FIDs, ATProto AppView, RSS/Atom; RSS3 GI optional) | Yes. Snapshot + server Gun | Seed peer still caches; browsers HAM-merge public items across the mesh |
| **Personal overlay** | The user, in their browser | Yes. Same item shape. Ingest + native posts. **Mine** tab. Stays local | Still not public unless they share |
| **Share-into-mesh** | User chooses to publish an **admitted** native post onto `gun.get('s3rch').get('items')` | Wired for own native posts (confirm + put). Not unshare. Not OutboundAdapter | Network tab / live mesh delivery. Overlay ingest still stays mine unless a later share lands |

`FeedTab = "public" | "mine" | "network"` — Public and Mine render. Network stays later (disabled copy: mesh).

Observing a wallet's **public** traces is not the person controlling that wallet dumping private overlay into the public cache. Mine vs public vs explicit share still holds for identity the same way it holds for feed items.

## Identity (KYC alternative that stays in crypto)

A s3r.ch user is **not** an email/password account and **not** government KYC. It is an identity graph assembled from public crypto traces — the same lean as RSS3 and other web3 work that looks for solid KYC alternatives without leaving crypto.

This is **not** AML or legal KYC, **not** PII collection, and **not** "verified human" theater. We do not claim sybil resistance or uniqueness proofs. We do not invent a token or a fake passport product. This slice ships SIWE (EOA + mainnet ERC-1271 / EIP-6492) + a cookie session on `/feed`, plus mainnet ENS / Unstoppable / Farcaster / Lens / RSS3 held claims after that session exists, plus light Check see-grants (not login). Coinbase Smart Wallet is an **onramp** (passkey smart account, then SIWE) — not a second IdP and not email login. WalletConnect is a wagmi connector **gated** on `NEXT_PUBLIC_WC_PROJECT_ID` (empty keeps injected + Smart Wallet, no WalletConnect; it is not a new IdP). It does not ship ENS/Unstoppable/fname/Lens/RSS3 as login, a KYC form, or a passport upload. s3r.ch does **not** use Panopticon Keycloak as an IdP. Login rules live in [identity.md](identity.md). Hypermesh portal stays Keycloak; this kit is s3r.ch login and later a Hypermesh wallet door.

### What a user is

We build a user from the wallets and other **public indicators we can actually pull**.

| Role | Source | This slice |
| --- | --- | --- |
| **Primary key** | Wallet address(es) | SIWE session subject is the checksummed address (EOA or ERC-1271 contract). Not a Gun user node yet. Overlay already accepts an RSS3 account (hex / `name.eth`) |
| **RSS3 account path** | Documented `GET /decentralized/{account}` | Wired as personal overlay ingest |
| **ENS / name.eth** | Mainnet reverse + forward after SIWE (`getEnsName` then `getEnsAddress`) | Held claim on `/feed` when both match the session address. Not login. Not written to Gun. Overlay RSS3 `name.eth` path unchanged |
| **Unstoppable** | Polygon UNS reverse + forward after SIWE (`reverseNameOf` then `crypto.ETH.address`). Optional server-only `UNSTOPPABLE_API_KEY` if on-chain throws | Held claim on `/feed` when both checksum-match. Not login. Not written to Gun. Empty key = quiet empty |
| **RSS3 GI activity** | Optional public lists when `RSS3_GI_BASE` resolves; account path for a wallet | Overlay ingest still wired. Public seed skips GI if DNS/HTTP fails. After SIWE, a GI overlay bound to the session address may show as a quiet held claim (not a dumped activity feed) |
| **Farcaster** | Native Hubble HTTP (`castsByFid` on protocol FIDs) | Public seed. After SIWE, custody reverse + FID registry forward is a held claim (fname or `fid:N`). Not Hub login / SIWF |
| **ATProto / Bluesky** | Public AppView author + generator feeds | Public seed. No auth |
| **Lens** | Public Lens GraphQL (`api.lens.xyz`) owned-account reverse + owner forward after SIWE; GI platform lists still optional for the seed | Held claim on `/feed` when both match. Not Lens OAuth / login |
| **On-chain tx / social tags** | `social`, `transaction`, plus `ethereum`, `base`, `farcaster`, `lens` | Already on feed items |
| **Later optional attestations** | Only if a real, pullable source exists | Not invented here. No passport, no token |

No Instagram, TikTok, Facebook, or locked-down X as identity sources — we cannot pull them (see the bridge matrix).

### Same graph, not a second database

Feed items already carry `author` and `provenance`. Identity emerges from the **same cache/mesh**, not a parallel store.

**Next schema note** (not implemented in this PR): a Gun user node keyed by wallet, with linked indicator ids, HAM-merged across the mesh like feed items.

```
gun.get('s3rch').get('users').get(wallet)
  { id: wallet, indicators: 'ens:name.eth,rss3:…,farcaster:…', provenance, ts }
```

- Lab seeder already concentrates **public** lists (activity, not a user registry).
- End-state browsers pull **their own** wallet indicators (through the same CORS proxy / relay / extension gate as feed ingest).
- Linking those indicators onto the wallet node is HAM-merge, same as items.
- Putting a wallet's public GI traces in the public cache ≠ publishing that person's private overlay. Explicit share-into-mesh still required.

### Held claims (default private)

We can collect **many proof types** onto the same user node. Holding a proof is not publishing it.

| Claim kind | What it is | Default visibility |
| --- | --- | --- |
| Wallets / public crypto indicators | Already: RSS3 account, ENS/`name.eth`, Farcaster hub FIDs, ATProto handles, Lens via GI when up, on-chain tags | Public **lists** the lab seeder already concentrates stay public cache. A holder's **assembled footprint** (all linked indicators) is overlay until granted |
| Third-party digital KYC attestations | Later, only if a real issuer exists. Not a s3r.ch passport product | **Private** (held claim) |
| Old-school email / phone confirmation | Later. Proves the claim **to the holder** | **Private**. Confirming an email does **not** publish it |

Those last two are supportable end-state, not this slice. This PR has no email/SMS, no KYC vendor, no verify UI.

### Visibility is a grant (lighter SociACL Check)

Seeing is a grant. The user decides **who** sees **which** claim and **when** (time-bounded). Nobody else sees the full footprint unless they were granted it. The public mesh only gets **explicitly shared** claims — the same rule as share-into-mesh.

This is a **lighter SociACL Check** on social/identity claims. It is not a new company and not bolting FyberLabs/SociACL (Elect, wills, devices, Case C) onto this Next app. Full SociACL stays outside this repo ([FyberLabs/SociACL](https://github.com/FyberLabs/SociACL)). This Next app **reimplements** the consume contract ([s3rch-check.md](s3rch-check.md)) in TypeScript and runs Check in the browser. Do not import the crate. s3r.ch is the product surface. Public mesh vs mine still applies: a see-grant is not share-into-mesh.

Map, using SociACL language **without importing the crate**:

| SociACL term | On s3r.ch |
| --- | --- |
| Object | Anything **in Gun**: a feed item or a held claim (wallet indicator, KYC attestation, email/phone confirmation). Not a remote RSS3/KYC JSON blob |
| Accessor | Another wallet / Gun peer |
| Check | `CHECK(see, claim, accessor)` evaluated **at now** |
| Grant | Jointly stated edge: holder and accessor both state it. **hopcap 1** — no friends-of-friends, no transitive “your friend’s grant” |
| Privilege-down | Revoke is **immediate**. The accessor loses `see` as soon as the grant is gone |
| Privilege-up | A new or wider grant **can wait** (propagation / mesh delay). Do not pretend it is instant everywhere |
| Attestation | Email/phone/KYC **issuers** are pre-enrolled verifiers. An attestation proves the claim to the holder. It is **not** a grant. Issuers do not publish the footprint |

```
held claim (overlay, private)
  → CHECK(see, claim, accessor) at now
      grant exists and now ∈ [from, until) → accessor may see that claim
      no grant / expired / revoked          → accessor sees nothing
  → explicit share-into-mesh                → that claim only, on the public cache
```

This slice ships light Check see-grants on the lab dest ACL. Live `/feed` must not claim KYC, uniqueness, or full mesh ACL. A grant is not login.

## How SociACL meets Gun (locks, 2026-08-31)

These locks stay put. s3r.ch (this repo) is **product / UX**. The full Gun adapter lives in SociACL (SociACL Dev Bot / [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL)). This Next app re-types the light consume contract and runs `CHECK(see, …)` in the browser. This is **not** Hypermesh Phase 1. This Next app does not import the crate, Elect, wills, devices, or Case C.

1. **Gun-stored data is native SociACL.** Feed items and held claims that live in Gun **are** SociACL objects. Light Check applies to dest-ACL objects in this app. Putting a row in Gun is admitting it to that object space — not a reason to skip Check.

2. **Non-Gun external data is URLs.** RSS3 GI, RSS/Atom, KYC issuer APIs, email/phone verifiers: we hold a **URL plus untrusted hints**, not a grant. `permalink` / provenance on a feed item may name that URL. The remote body is not a SociACL object until something we control re-authorizes it into Gun.

3. **Crossing a URL is an edge handoff, not a grant.** `/api/ingest` and the lab seeder fetch are handoffs. Fetching does **not** mint `see`. A successful HTTP 200 from GI or a feed is not `CHECK(see, …)` and does not enroll an accessor.

4. **The destination must not trust our metadata** except untrusted hints: user/agent ID as we consider them, the data we think they are requesting, optional verb/context. The destination **re-authorizes**. When **we** are the destination (ingest or seeder returning into Gun), we re-authorize **before** putting a native SociACL object in Gun. Do **not** copy RSS3 / KYC response fields into a grant.

5. **Social Light hop** can factor a Check; it **cannot mint the grant**. Mentioned once. No hop UI in this slice.

```
URL (RSS3 / RSS / issuer)  --handoff-->  fetch
     hints only (untrusted): who we think, what we think they asked, optional verb
     destination re-authorizes
        we are destination → re-authorize → put native SociACL object in Gun
        we are not         → they re-authorize; our hints are not their grant
Check (this Next app, consume contract; full plane stays in SociACL) applies only to Gun-stored / dest-ACL objects
```

## Source of truth (now)

Gun is already the graph. This slice uses a bootstrap path so Azure does not have to serve every subscription.

- Server process holds a Gun instance (radisk on the App Service container disk, plus an in-memory index and a JSON snapshot for restarts).
- `gun-preload.cjs` attaches Gun to the Node HTTP server (`listen` patch, radisk under `/app/data/radata`). That is the **seed peer**, not a finished mesh.
- `/feed` hydrates a client Gun from `GET /api/feed`, then `gun.get(...).map().on(...)`. That is snapshot hydration **now**, so the page works if WebSockets are off.
- If every live source fails, the seeder writes nothing. The feed stays empty. No invented rows. A down RSS3 GI host does not empty Farcaster / ATProto / RSS pulls.

## Honest gates

These are real constraints. Do not paper over them.

1. **Browser CORS.** Farcaster Hubble, ATProto AppView, RSS3 GI, and most RSS/Atom feeds will not load cross-origin from `s3r.ch`. `/api/ingest` is the same-origin proxy until a relay or extension exists. Direct browser-to-source is not magic. The end-state still has browsers pull and write the graph; they do it through a proxy, relay, or extension, not by pretending CORS is gone.
2. **App Service WebSockets.** This slice hydrates from snapshot because WebSockets may be off on the App Service. Next slice: enable WS so `/gun` is a real peer, then `gun/lib/webrtc` so browsers talk to each other when the seed peer is idle. This PR does not enable WS, wire WebRTC, or claim `/gun` already meshes browsers.
3. **Ephemeral container disk.** The seed peer is a **cache**, not durable storage. A recycle empties radisk and the snapshot until the next seed, or until a browser peer still holds the graph. Do not treat `/app/data` as the archive.

## Item shape

Every item in the public cache, the snapshot, the overlay, and (later) the mesh uses the same shape:

```ts
{
  id: string          // canonical activity id, guid, or permalink
  source: string      // rss3 | rss | atom | farcaster | atproto | s3rch
  kind: string        // RSS3 tag (social, transaction, …) or rss / atom
  author: string
  body: string
  ts: number          // unix seconds
  permalink: string
  tags: string[]      // kind + platform/network slugs
  provenance: string  // where it was pulled from
}
```

Gun does not store arrays. On disk / on the wire, `tags` is a comma-separated string. Readers split; writers join.

### Tags

Tags are the filter and engagement primitive for this slice.

- From RSS3: the activity/action `tag` (`social`, `transaction`, …).
- Plus platform / network slugs when present (`farcaster`, `lens`, `ethereum`, `base`).
- From Farcaster hub: `farcaster`, `social`.
- From ATProto AppView: `atproto`, `bsky`, `social`.
- From public RSS/Atom: `rss` or `atom`, plus `ethereum` / `farcaster` / `social` when the feed is that network.
- Overlay RSS/Atom ingest still adds `user`.
- Native s3r.ch posts add `user` and `s3rch`.
- Deduped, lowercased, no empty strings.
- Filter primitive: TagChips any-match on the **active tab**. Ranker: more matching tags first, then `ts` desc. No engagement scores. No Popular / Novel columns.

### Item identity and merge

Dedupe key is `id` if present, otherwise the normalized permalink URL.

Same shape everywhere so a browser peer can HAM-merge without a second schema. Provenance names the real URL (`farcaster:hub:…`, `atproto:…`, `rss:{url}`, `atom:{url}`, `rss3:gi:…`). `author` is a public indicator (handle, owner, from), not a logged-in account.

## Public seeder (bootstrap cache)

Fetching a URL is an edge handoff, not a grant. Empty or failed sources write nothing. `POST /api/seed` is **503** only when `sourcesOk=0` **and** there is an error. A dead GI host must not empty the other sources.

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

The site is a Next.js standalone container on Azure App Service (port 8080). There is no second Azure service and no Terraform in this repo. App Service is a **seed peer + bootstrap cache**, not the chat server.

The container runs Next's standalone `server.js` with `node -r ./gun-preload.cjs`:

1. Preload patches `http.Server.prototype.listen` and attaches Gun (`web: server`, radisk under `/app/data/radata`).
2. The process listens on `PORT` / `HOSTNAME` (8080).
3. `/feed` does not require a live `/gun` WebSocket in this slice.

`/api/health` stays `{ "status": "ok" }` for the existing Deploy smoke test.

## In / out bridge matrix

Most social networks are walled gardens. This table is the honest matrix. **Yes** means the network actually exposes a pull or post API we could use. **No** means we will not pretend.

| Network | Pull in | Repost out | This slice |
| --- | --- | --- | --- |
| RSS3 Data Sublayer | yes | yes (GI write is not used here) | optional public seeder + address ingest; `gi.rss3.io` currently has no DNS |
| RSS / Atom | yes | yes (feed file / ping) | public seeder + URL ingest, same-origin proxy |
| ActivityPub | yes | yes | not wired |
| ATProto / Bluesky | yes | yes | public seeder pull via AppView (no auth) |
| Nostr | yes | yes | not wired |
| Farcaster | yes (Hub HTTP + GI) | yes (where APIs exist) | public seeder pull via Hubble HTTP (Pinata, no API key) |
| Lens | yes (GI + Lens API) | yes (where APIs exist) | pull via RSS3 GI only (GI optional / currently no DNS) |
| Instagram | no | no | none |
| TikTok | no | no | none |
| Facebook | no | no | none |
| X (locked-down) | no | no | none |

Outbound: `OutboundAdapter` is an interface only. Native s3r.ch compose is **not** a Farcaster / ATProto / RSS bridge. Nothing claims posting-to-those-networks works.

## Later (not this follow-up)

- Enable App Service WebSockets; `/gun` as a real seed peer.
- `gun/lib/webrtc` so browsers mesh when the seed peer is idle.
- Browsers pull allowed sources (through proxy / relay / extension) and HAM-merge.
- Live mesh delivery of granted objects. Network tab. Unshare / HAM-delete.
- Gun user node keyed by the SIWE address; browsers pull their own indicators as **held claims**. Wire the SEA pair (not `recall` to sessionStorage) and PRF wrap after SIWE is proven.
- Mesh-wide Check on Gun-stored objects (this slice is the lab dest ACL). URL fetches remain handoffs; they do not mint `see`. Not Hypermesh Phase 1. Social Light hop can factor a Check later; it cannot mint a grant.
- Email/phone confirmation and third-party KYC attestations as private claims (prove to holder ≠ publish).
- Streaming, chat, and sharing as Gun subscriptions (no chat UI here).
- Real ActivityPub / Nostr adapters, and Farcaster / ATProto **outbound** (pull for seed is wired; posting is not).
- Durable storage is the mesh (and any later durable seed), not the container disk.

## Out of scope (do not restore)

- Public `/research` and plantuml.com embeds. `session-uc.wsd` / `group-uc.wsd` stay in git, unlinked.
- Popular vs novel columns.
- Invented GI or search APIs, token, or protocol pages.
- 2019 session/group contracts and tokenomics.
- Azure OIDC / Deploy secrets.
- Chat UI, rooms, presence, or WebRTC wiring in this slice.
- ENS / Unstoppable / fname / Lens / RSS3 as login, Farcaster SIWF, KYC form, passport upload, email/SMS verify, or claims of legal KYC / sybil resistance / uniqueness. WalletConnect is gated on `NEXT_PUBLIC_WC_PROJECT_ID` (see [identity.md](identity.md)); do not invent a project id.
- Importing the SociACL Rust core into this Next app, or exposing Elect / wills / devices / Case C on s3r.ch.
- Treating a seeder or `/api/ingest` fetch as a grant, or copying RSS3/KYC fields into a grant.
- A hop UI, Elect / wills / Case C, or claiming uniqueness / KYC / full mesh ACL already works on live `/feed`.
