# s3r.ch

[s3r.ch](https://s3r.ch) is a Fyber Labs lab domain. It is not a live search product.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh), [Tennessee Windage](https://tennesseewindage.com).

The public [lab feed](/feed) is a GunDB graph. This slice’s seeder and `GET /api/feed` snapshot are a bootstrap cache (so the graph is not empty and App Service is not the chat server). The browser tries the same-origin `/gun` seed peer over WebSocket and fails open to the snapshot if the socket is down (Cloudflare + Azure ARR). `gun/lib/webrtc` is also loaded with STUN ICE (`stun:stun.l.google.com:19302`). Signed-in browsers may fetch short-lived TURN `iceServers` from same-origin `/api/turn/allocate` (Next hops to Panopticon; empty env stays STUN-only). STUN is not TURN. If WebRTC fails, the seed peer / snapshot path is unchanged. That is not a finished P2P mesh. The end-state is a mostly browser-to-browser Gun mesh. The public seeder pulls live Farcaster Hubble HTTP, ATProto AppView, RSS/Atom, ActivityPub actor outboxes, and Nostr kind 1 notes (NIP-01 on a documented relay). Signed-in browsers can pull those same documented sources through the same-origin `/api/ingest` CORS proxy **or** an allowlisted unpacked extension / `127.0.0.1` relay ([docs/pull-relay.md](docs/pull-relay.md)), admit `GunFeedNode` `v: 1` onto Mine, and HAM-merge onto `s3rch/items` only after an explicit share into the mesh. Direct browser-to-source still fails CORS in a naked tab. `/api/ingest` stays the fallback. A signed-in holder can **Post to Farcaster** or **Post to Bluesky** on an owned Mine note (`POST /api/outbound`, SIWE). That is not share-into-mesh and not an auto-bridge. ActivityPub / Nostr outbound is not wired. RSS3 Global Indexer (`gi.rss3.io`) is optional and currently has no public DNS — a GI failure does not empty the other sources or invent rows. Gun-stored items and claims are native SociACL objects. This app reimplements light Check see-grants in the browser ([docs/s3rch-check.md](docs/s3rch-check.md)); it does not import FyberLabs/SociACL. URL fetches are handoffs, not grants. `/feed` can Sign in with Ethereum (SIWE + cookie session). After sign-in, verified mainnet ENS, Unstoppable, Farcaster, Lens, and RSS3 indicators link onto the Mine overlay Gun user node (`s3rch/users/<wallet>` shape, local until share — not session-display-only). Email / phone confirm and a fixture KYC attestation are the same kind of private held claim (`email:…` / `phone:…` / `kyc:<issuer>:…`) — proving the claim to the holder is not publishing it. The holder can share that node or an individual claim onto the public graph, and can grant or revoke `see` on claims and on own native posts. A live see-grant also **delivers** that Gun-stored object onto `s3rch/granted/<accessor>` — the accessor **Granted** tab after SIWE. Holding a claim is not publishing it. Native posts stay on **Mine** until an explicit share to public; a see-grant is not that share. First delivery can wait on the mesh; revoke is immediate on dest ACL. Owners can **unshare** a previously shared post, room, user node, or claim (HAM tombstone / republish without that indicator). Observation can wait — this is not instant mesh-wide delete, and it is not a see-grant revoke. Delivery does not write those public paths and must not resurrect unshared public rows. There is no `/api/users`, no `/api/unshare`, and no `/api/deliver`. Rooms are Gun threads (Mine by default; share the room node separately). **Public** keeps snapshot hydrate plus shared posts. **Network** reads the live shared Gun graph (`s3rch/items`, `s3rch/rooms`) via seed peer / WebRTC — not Mine overlay, not ingest, not the snapshot. **Granted** is the see-grant inbox — not Public, not Network, not search. **Discover** browses tags already on Public and that live Network mesh (inventory counts, same tags-first ranker; Mine overlay and Granted are not that list). It is not a search API and not Popular/Novel. Live chat and room presence are Gun subscriptions on a room you can already see (SIWE to send or announce; unsigned visitors can read public-room chat and presence). Meetings and streams are later. Path A TURN allocate is documented in [docs/durable-graph-and-turn.md](docs/durable-graph-and-turn.md). This repo does not deploy coturn. Check is grants, not login. Farcaster / ATProto outbound is an explicit Mine action when server credentials are set; missing creds fail closed. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/identity.md](docs/identity.md).

## Issues and review

Public intake is [GitHub Issues](https://github.com/FyberLabs/s3r.ch/issues/new/choose) (structured forms only). How to file, including the AI review path, is in [CONTRIBUTING.md](CONTRIBUTING.md). Hypermesh questions go to [https://hyperme.sh](https://hyperme.sh), not this backlog.

## Stack

- **Next.js 16** + **React 19** (App Router, `output: "standalone"`)
- **GunDB** (same-process peer on the App Service container)
- **TypeScript**
- **Tailwind CSS**
- **Node 24** / npm

## Setup

```bash
npm ci
```

Optional local env:

```
SEED_SECRET=dev-seed
GUN_FILE=./data/radata
GUN_SNAPSHOT=./data/snapshot.json
IDENTITY_SESSION_SECRET=local-dev-identity-session-secret-32
NEXT_PUBLIC_WC_PROJECT_ID=
UNSTOPPABLE_API_KEY=
FARCASTER_FID=
FARCASTER_SIGNER_KEY=
FARCASTER_HUB_AUTH=
ATPROTO_IDENTIFIER=
ATPROTO_APP_PASSWORD=
ATPROTO_PDS_BASE=
PANOPTICON_TURN_BASE=
PANOPTICON_TENANT_ID=
PANOPTICON_API_KEY=
PANOPTICON_ORACLES_BASE=
PANOPTICON_PAYMENTS_BASE=
CONFIRM_SEND_URL=
CONFIRM_FIXTURE=
KYC_ISSUER_URL=
```

`IDENTITY_SESSION_SECRET` must be at least 32 characters. It is required in production (verify returns 500 if missing). Locally, an unset secret falls back to a documented default — see [docs/identity.md](docs/identity.md). Operator step: set it on App Service (Key Vault later).

`NEXT_PUBLIC_WC_PROJECT_ID` is optional. Empty (default) keeps `/feed` without WalletConnect; injected Connect wallet and the ungated Passkey wallet (Coinbase Smart Wallet onramp, then SIWE) still ship. Next.js inlines it at build time — see [docs/identity.md](docs/identity.md). Do not invent or commit a Reown project id.

`UNSTOPPABLE_API_KEY` is optional and **server-side only**. Empty keeps Polygon on-chain Unstoppable lookup; a miss is a quiet empty claim. Never put it in `NEXT_PUBLIC_*`. Do not invent or commit a UD partner key.

`PANOPTICON_TURN_BASE`, `PANOPTICON_TENANT_ID`, and `PANOPTICON_API_KEY` are optional and **server-side only**. All three App Service application settings are required for live TURN; empty or any missing keeps STUN + `/gun` (no error theater on `/feed`). `PANOPTICON_TURN_BASE` is the allocate origin (or origin+/api/v1[/turn]); Next hops `POST /api/v1/turn/allocate`. Operator / infra: Research sets them in FyberLabs/infra `terraform/s3rch` — hold the API key in Key Vault (`kv-fyber-cg47`, same habit as `SEED_SECRET` / `IDENTITY_SESSION_SECRET`); TF wires secret → App Setting. Never `NEXT_PUBLIC_*`, never Gun, never the browser, never git. This repo does not deploy coturn (Path A consume only). Contract: FyberLabs/panopticon `products/turn/docs/turn-allocate-v0.md`. Checklist: [docs/durable-graph-and-turn.md](docs/durable-graph-and-turn.md#operator--infra-habit-live-turn).

`PANOPTICON_ORACLES_BASE` is optional and **server-side only**. Together with the shared `PANOPTICON_TENANT_ID` + `PANOPTICON_API_KEY`, it enables a SIWE-gated hop: `POST /api/oracles/attest` → Panopticon `POST /api/v1/oracles/v0/attest`. Empty or any missing keeps today’s browser-first SIWE / ENS / ERC-1271 (no error theater on `/feed`, no invented grant from a missing digest). `PANOPTICON_ORACLES_BASE` is the attest origin (or origin+/api/v1[/oracles[/v0]]). Lab: `https://api.test.hyperme.sh`. Never `NEXT_PUBLIC_*`. Never Gun. Contract: FyberLabs/panopticon [`oracles-attest-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/oracles/docs/oracles-attest-v0.md). Smoke: [docs/oracles-and-payments-prep.md](docs/oracles-and-payments-prep.md).

`PANOPTICON_PAYMENTS_BASE` is an **env stub only** (server-side). Empty (default) means no hop — no hard paywall. Payments stay held: later `POST /api/v1/payments/v0/receipt` (intent optional). Contract: [`payments-access-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/payments/docs/payments-access-v0.md).

`CONFIRM_SEND_URL` is optional and **server-side only**. Empty keeps live email/SMS send as honest "not configured". Non-production uses lab fixture code `000000` unless `CONFIRM_FIXTURE=0`. Confirming an email or phone is a private held claim after SIWE — not login, and not a public Gun put until the holder shares that claim id.

`KYC_ISSUER_URL` is optional and **server-side only**. Empty keeps the fixture issuer (`kyc:fixture:held`). Do not invent a vendor or a passport upload. Never `NEXT_PUBLIC_*`.

`FARCASTER_FID` + `FARCASTER_SIGNER_KEY` (ed25519 hex) enable Farcaster outbound through `FARCASTER_HUB_BASE` (`POST /v1/submitMessage`). Optional `FARCASTER_HUB_AUTH` is hub Basic auth. Empty = buttons fail closed (*Farcaster hub is not configured.*). Never `NEXT_PUBLIC_*`.

`ATPROTO_IDENTIFIER` + `ATPROTO_APP_PASSWORD` enable Bluesky outbound through `ATPROTO_PDS_BASE` (default `https://bsky.social` — not the public AppView). Empty = *Bluesky app password is not configured.* Never `NEXT_PUBLIC_*`. Do not put app passwords or signer keys on Gun.

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Production-shaped process (standalone Next + Gun preload on one HTTP server):

```bash
npm run build
PORT=8080 HOSTNAME=0.0.0.0 npm start
```

Seed the public graph (writes into Gun from live public sources, does not invent rows):

```bash
curl -X POST http://localhost:8080/api/seed \
  -H "Authorization: Bearer dev-seed"
```

Health check: `GET /api/health` returns `{ "status": "ok" }`.

## Tests

```bash
npm test
```

Tests cover `lib/*.test.ts` and `lib/identity/*.test.ts`.

Optional local pull relay (loopback only; not Azure):

```bash
npm run pull-relay
```

Unpacked MV3 scaffold: `extensions/s3rch-pull`.
