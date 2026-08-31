# s3r.ch architecture (2026-08-31)

Internal notes for the lab prototype. This is not a public `/research` route, not a protocol spec, and not tokenomics.

s3r.ch is a Fyber Labs lab site. **Gun is the graph.** RSS3 Data Sublayer activity and other allowed sites / crypto-social sources concentrate on that graph. Popular items cache across peers. The same graph is the unique real-time streaming / chat / sharing network — **mostly browser-to-browser**, not a chat server we host.

This slice does **not** ship chat UI, rooms, presence, or WebRTC. Snapshot hydration is **now**. The mesh is **next**. The live `/feed` copy stays a lab prototype and does not claim posting or P2P already work.

## End-state vs this slice

| | Now (this PR) | Next / end-state |
| --- | --- | --- |
| Who pulls RSS3 and other allowed sources | Lab seeder on the container; `/api/ingest` as a same-origin proxy | Lab **and** users' browsers, writing the same item shape |
| Where the graph lives | Server Gun + JSON snapshot; client Gun hydrated from `GET /api/feed` | HAM-merged mesh. Browsers are Gun peers. Popular items cache across peers |
| Azure App Service | Seed peer + bootstrap cache so the graph is not empty | Still a seed peer — **not** the realtime / chat server |
| Streaming, chat, sharing | Not built | Gun subscriptions on that mesh, mostly peer-to-peer |
| Tabs | Type only (`public` / `mine` / `network`) | Split public mesh vs mine. Users do not dump every pull into the public seed by default |

The lab seeder and `GET /api/feed` are a **bootstrap cache**. They exist so first paint is not an empty graph and so App Service does not have to be the chat server.

```
now:
  lab seeder → server Gun (seed peer) → GET /api/feed snapshot → client Gun
  user overlay → POST /api/ingest (CORS proxy) → client Gun only (not public seed)

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
| **Public cache** | Lab seeder (documented RSS3 GI lists) | Yes. Snapshot + server Gun | Seed peer still caches; browsers HAM-merge public items across the mesh |
| **Personal overlay** | The user, in their browser | Yes. Same item shape, provenance, dedupe by id/url. Stays local | Tabs: **Mine**. Still not public unless they share |
| **Share-into-mesh** | User chooses to publish an overlay item onto the public graph | Not wired. No UI that claims it | Explicit action. **Network** / public tab reads the mesh, not every private pull |

`FeedTab = "public" | "mine" | "network"` remains a type only. No tab UI in this slice.

## Source of truth (now)

Gun is already the graph. This slice uses a bootstrap path so Azure does not have to serve every subscription.

- Server process holds a Gun instance (radisk on the App Service container disk, plus an in-memory index and a JSON snapshot for restarts).
- `gun-preload.cjs` attaches Gun to the Node HTTP server (`listen` patch, radisk under `/app/data/radata`). That is the **seed peer**, not a finished mesh.
- `/feed` hydrates a client Gun from `GET /api/feed`, then `gun.get(...).map().on(...)`. That is snapshot hydration **now**, so the page works if WebSockets are off.
- If RSS3 returns nothing, the seeder writes nothing. The feed stays empty. No invented rows.

## Honest gates

These are real constraints. Do not paper over them.

1. **Browser CORS.** RSS3 GI (`https://gi.rss3.io`) and most RSS/Atom feeds will not load cross-origin from `s3r.ch`. `/api/ingest` is the same-origin proxy until a relay or extension exists. Direct browser-to-GI is not magic. The end-state still has browsers pull and write the graph; they do it through a proxy, relay, or extension, not by pretending CORS is gone.
2. **App Service WebSockets.** This slice hydrates from snapshot because WebSockets may be off on the App Service. Next slice: enable WS so `/gun` is a real peer, then `gun/lib/webrtc` so browsers talk to each other when the seed peer is idle. This PR does not enable WS, wire WebRTC, or claim `/gun` already meshes browsers.
3. **Ephemeral container disk.** The seed peer is a **cache**, not durable storage. A recycle empties radisk and the snapshot until the next seed, or until a browser peer still holds the graph. Do not treat `/app/data` as the archive.

## Item shape

Every item in the public cache, the snapshot, the overlay, and (later) the mesh uses the same shape:

```ts
{
  id: string          // canonical activity id, guid, or permalink
  source: string      // rss3 | rss | atom
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
- From RSS/Atom: `rss` or `atom`, plus `user`.
- Deduped, lowercased, no empty strings.

### Identity and merge

Dedupe key is `id` if present, otherwise the normalized permalink URL.

Same shape everywhere so a browser peer can HAM-merge without a second schema. Provenance stays on the item (`rss3:gi:…`, `rss:{url}`, `atom:{url}`).

## RSS3 seeder (bootstrap cache)

Documented GI base: `https://gi.rss3.io` ([RSS3 Data Sublayer API](https://docs.rss3.io/guide/developer/api)).

Public seed pulls **only** these documented list endpoints:

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

No search-query API. No invented GI routes. Empty or failed sources produce no rows.

Cadence:

- `POST /api/seed` with `Authorization: Bearer $SEED_SECRET` writes into Gun.
- GitHub Action `.github/workflows/seed.yml` on a weekday-hours cadence (and `workflow_dispatch`) hits that route on the live container.
- In production, a missing secret refuses the seed. Locally, an unset secret is allowed so the container can hit itself.

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
| RSS3 Data Sublayer | yes | yes (GI write is not used here) | public seeder + address ingest (proxy) |
| RSS / Atom | yes | yes (feed file / ping) | URL ingest, same-origin proxy |
| ActivityPub | yes | yes | not wired |
| ATProto / Bluesky | yes | yes | not wired |
| Nostr | yes | yes | not wired |
| Farcaster | yes (GI + Hub/API) | yes (where APIs exist) | pull via RSS3 only |
| Lens | yes (GI + Lens API) | yes (where APIs exist) | pull via RSS3 only |
| Instagram | no | no | none |
| TikTok | no | no | none |
| Facebook | no | no | none |
| X (locked-down) | no | no | none |

Outbound: `OutboundAdapter` is an interface only. Nothing claims posting works. There is no post button.

## Later (not this follow-up)

- Enable App Service WebSockets; `/gun` as a real seed peer.
- `gun/lib/webrtc` so browsers mesh when the seed peer is idle.
- Browsers pull allowed sources (through proxy / relay / extension) and HAM-merge.
- Explicit share-into-mesh. Public / Mine / Network tabs.
- Streaming, chat, and sharing as Gun subscriptions (no chat UI here).
- Real ActivityPub / ATProto / Nostr / Farcaster adapters (pull and, where authorized, post).
- Durable storage is the mesh (and any later durable seed), not the container disk.

## Out of scope (do not restore)

- Public `/research` and plantuml.com embeds. `session-uc.wsd` / `group-uc.wsd` stay in git, unlinked.
- Popular vs novel columns.
- Invented GI or search APIs, token, or protocol pages.
- 2019 session/group contracts and tokenomics.
- Azure OIDC / Deploy secrets.
- Chat UI, rooms, presence, or WebRTC wiring in this slice.
