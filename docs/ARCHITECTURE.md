# s3r.ch architecture (2026-08-31)

Internal notes for the lab prototype. This is not a public `/research` route, not a protocol spec, and not tokenomics.

s3r.ch is a Fyber Labs lab site. The public feed is a **GunDB graph**. RSS3 Data Sublayer activity is pulled on a cadence and **seeded into Gun**. The browser does not treat a live RSS3 fetch as its data source.

## Source of truth

Gun is the graph.

- Server process holds a Gun instance (radisk directory on the App Service container disk, plus an in-memory index and a JSON snapshot for restarts).
- `gun-preload.cjs` attaches a Gun peer to the Node HTTP server (radisk under `/app/data/radata`). Azure App Service WebSockets are optional and not required for the feed to render.
- The public `/feed` page hydrates a client Gun graph from `GET /api/feed` (a snapshot of the server graph), then subscribes with `gun.get(...).map().on(...)`.
- If RSS3 returns nothing, the seeder writes nothing. The feed stays empty. No invented rows.

## Item shape

Every item in the graph, the snapshot, and the overlay uses the same shape:

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

User overlay items use the same shape. They are **merged in the client Gun graph**, not written into the public seed. Provenance distinguishes them (`rss3:gi:/decentralized/{account}`, `rss:{url}`, `atom:{url}`).

```
public seed  →  server Gun  →  GET /api/feed  →  client Gun
user overlay →  POST /api/ingest (fetch+normalize only)  →  client Gun merge
```

### Tabs (later)

`FeedTab = "public" | "mine" | "network"` exists as a type only. No tab UI in this slice.

## RSS3 seeder

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

The site is a Next.js standalone container on Azure App Service (port 8080). There is no second Azure service and no Terraform in this repo.

The container runs Next's standalone `server.js` with `node -r ./gun-preload.cjs`:

1. Preload patches `http.createServer` / `listen`.
2. Gun attaches to that HTTP server (`web: server`, radisk under `/app/data/radata`).
3. Requests to `/gun` skip Next so the Gun peer can answer.
4. The process listens on `PORT` / `HOSTNAME` (8080).

`/api/health` stays `{ "status": "ok" }` for the existing Deploy smoke test.

Container disk is ephemeral. A recycle loses the Gun file and snapshot until the next seed. That is expected.

## In / out bridge matrix

Most social networks are walled gardens. This table is the honest matrix. **Yes** means the network actually exposes a pull or post API we could use. **No** means we will not pretend.

| Network | Pull in | Repost out | This slice |
| --- | --- | --- | --- |
| RSS3 Data Sublayer | yes | yes (GI write is not used here) | public seeder + address ingest |
| RSS / Atom | yes | yes (feed file / ping) | URL ingest, server fetch + normalize |
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

## Later

- Public / Mine / Network tabs.
- Real ActivityPub / ATProto / Nostr / Farcaster adapters (pull and, where authorized, post).
- Durable Gun storage beyond the container disk.
- Engagement beyond tag chips.

## Out of scope (do not restore)

- Public `/research` and plantuml.com embeds. `session-uc.wsd` / `group-uc.wsd` stay in git, unlinked.
- Popular vs novel columns.
- Invented GI or search APIs, token, or protocol pages.
- 2019 session/group contracts and tokenomics.
- Azure OIDC / Deploy secrets.
