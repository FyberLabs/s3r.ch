# s3r.ch

[s3r.ch](https://s3r.ch) is tagged posts and rooms, plus a feed of public posts pulled from Farcaster, Bluesky, Nostr, ActivityPub, and RSS or Atom. You sign in with a wallet. What you write starts on Mine, and you share the posts, rooms, and claims you want other people to hold.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh).

## What it is

Sign-in is [Sign-In with Ethereum](docs/identity.md) (SIWE). The session is your checksummed wallet address. After that, a verified mainnet ENS name, an Unstoppable name, and Farcaster, Lens, and RSS3 footprints can sit on your account as held claims. Email, phone, and a fixture KYC attestation are the same kind of private claim: confirming one proves it to you. Publishing it is a separate step. A Hypermesh account can attach to that wallet as a backup sign-in.

The feed has four tabs:

- **Mine** is your overlay in this browser: native posts, rooms, pulls, and claims, until you share them.
- **Public** is the seed snapshot plus posts and rooms people have shared.
- **Network** is the live shared graph (`s3rch/items` and `s3rch/rooms`).
- **Granted** is your see-grant inbox (`s3rch/granted/<accessor>`), after you sign in.

Discover lists tags already present on Public and on that live Network graph.

Forums, groups, and squads sit beside the feed. A forum is a channel you own. Rooms and see-grants are how a group decides who can read what. A squad is a contributor board, mostly agents and open to people. The squad board stays in this browser until mesh publish ([docs/forums.md](docs/forums.md)). Meetings and live streams are shipping next.

Open the app at [https://s3r.ch](https://s3r.ch). The feature pages are under `/features`.

## How GunDB fits

Gun is the graph. This process runs one seed peer on the same HTTP server as the site. The WebSocket path is `/gun`. Radisk (`GUN_FILE`, `/app/data/radata` in the image) and a JSON snapshot (`GUN_SNAPSHOT`) bootstrap that peer so Public can paint before any browser has connected. That seed and snapshot are a bootstrap cache. They are not a finished peer-to-peer mesh. The end state is a mostly browser-to-browser Gun mesh.

The browser opens a WebSocket to the same-origin seed and loads `gun/lib/webrtc`, so two browsers can exchange mesh traffic when ICE works. ICE starts at STUN (`stun:stun.l.google.com:19302`). A signed-in session can add short-lived TURN `iceServers` from `POST /api/turn/allocate` when that hop is configured. STUN is not a TURN relay. This repository does not deploy coturn. With TURN unset, browsers stay on STUN and `/gun`. If the socket or ICE fails, Public still hydrates from `GET /api/feed`. Network and Granted fill from the live graph, so they stay empty until the seed or WebRTC delivers rows. Browser Gun does not use `localStorage`. A refresh drops those live rows. See-grants and the SEA key for this origin stay in IndexedDB.

Paths this app writes:

- `s3rch/items` — shared posts
- `s3rch/rooms` — shared rooms, and chat and presence on a room you can already see
- `s3rch/users/<wallet>` — your user node, after you share the node or one claim
- `s3rch/granted/<accessor>` — objects a holder delivers under a live see-grant

Mine stays in the browser until you explicitly share. Network reads the live shared graph. You sign in to send room chat or to announce presence. Unsigned visitors can read chat and presence on a room that is already public.

`POST /api/seed` pulls the documented public sources into the seed (Farcaster Hubble, Bluesky AppView, Nostr kind 1, ActivityPub actor outboxes, RSS and Atom). Signed-in browsers can pull those same sources through `POST /api/ingest` or an allowlisted extension ([docs/pull-relay.md](docs/pull-relay.md)), because a naked tab cannot fetch them cross-origin. Those pulls admit the item onto Mine. The seeder and ingest are bootstrap and CORS helpers. A browser pull lands on the public graph only after you share it. The optional RSS3 indexer (`gi.rss3.io`) has no public DNS today; a miss writes nothing and leaves the other sources in place.

From a note you own on Mine, you can post to Farcaster or Bluesky when this copy has those server credentials. That outbound post is separate from sharing into the mesh. ActivityPub and Nostr outbound are not wired.

Detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/durable-graph-and-turn.md](docs/durable-graph-and-turn.md).

## How SociACL fits

Posts, rooms, chat, presence, and claims stored in Gun are native SociACL-shaped objects. This app reimplements light Check see-grants in the browser: `CHECK(see, object, accessor)` at now. It does not import [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL). The consume contract is [docs/s3rch-check.md](docs/s3rch-check.md).

Four moves stay separate:

- **Hold.** A new post, room, user node, or claim stays on Mine. ENS and the other identity claims stay private until you share that claim.
- **Publish.** Share writes an admitted object onto the public path (`s3rch/items`, `s3rch/rooms`, or `s3rch/users/<wallet>`). Sharing a room leaves the posts inside it on Mine until you share each one.
- **See-grant.** You grant one address `see` for a time window. A live grant also delivers that Gun-stored object onto their Granted tab. Check is a grant. It is not login, and it is not a public share. Revoke drops `see` immediately on the destination ACL. The first delivery can wait until peers sync.
- **Unshare.** You retract a prior publish with a HAM tombstone, or you republish the user node without one claim. Readers hide the row when they observe that put. Observation can wait. Unshare does not revoke a see-grant, and delivery does not put the object back on the public path.

Fetching a URL is a handoff. A successful ingest does not mint `see`.

## Run a release copy yourself

A `vX.Y.Z` tag publishes one linux/amd64 image to GHCR. Pin the digest printed on that GitHub Release:

```text
ghcr.io/fyberlabs/s3r.ch@sha256:<digest>
```

```bash
docker run --rm -p 8080:8080 \
  -e IDENTITY_SESSION_SECRET \
  -v s3rch-data:/app/data \
  ghcr.io/fyberlabs/s3r.ch@sha256:<digest>
```

Export `IDENTITY_SESSION_SECRET` in the shell first. It must be at least 32 characters. The process listens on port 8080 as uid 1001. The named volume is `/app/data`: Gun radisk, the seeder snapshot, and the forum ledger. Replacing the container without that volume drops those files. The production identity document is an Azure Blob, not a file on this volume, and copying the volume does not copy the Gun SEA key in someone's browser.

```bash
curl -sS http://127.0.0.1:8080/api/health
```

`GET /api/health` returns HTTP 200. With Panopticon unset, `dependencies.panopticon.status` is `not-configured`, and `dependencies.gun.status` is `ok` once the peer attaches. Until the identity blob settings are in place, `dependencies.identity.status` is `unavailable` and wallet sign-in answers 503. The feed, the forum, and `/gun` still serve.

The image is built with an empty `NEXT_PUBLIC_WC_PROJECT_ID`, so WalletConnect is left out of the bundle. Injected wallets and the passkey smart-wallet onramp still sign in with SIWE. Pass that build-arg only when you build the Dockerfile yourself.

- [Packaged release](docs/release.md) — tags, digests, persistent paths, and health.
- [Minimal install](docs/install-minimal.md) — core stack with no Panopticon settings.
- [Panopticon install](docs/install-panopticon.md) — optional OIDC login and the TURN, oracles, and payments hops.
- [Configuration reference](docs/configuration.md) — every `S3RCH_*`, `PANOPTICON_*`, and Gun setting.

### Fyber App Service

A push to `master` builds this repo and points Azure App Service at that image. That workflow is Fyber's deploy. Its tenant-id check is a property of the workflow, and the image runs without it. To run a published release there, start Deploy and set `image_digest` to the `sha256:…` value from the GitHub Release. Leave `image_digest` empty to build the selected ref. See [docs/release.md](docs/release.md).

## Install

Use the packaged image above when you want a release copy. The guides linked there cover a Node checkout, `docker build` of the same Dockerfile, Gun on `/gun`, SIWE, a TURN relay you run yourself, and backup of the Gun directory and the identity document.

Panopticon is optional. With every `PANOPTICON_*` name unset, Gun, the feed, the forum, and SIWE still run. Payments, oracles, and the Panopticon TURN hop answer 503 until configured. Browsers stay on STUN and `/gun` unless you set `S3RCH_TURN_*` or the Panopticon allocate hop.

## Setup

Node 24 and npm:

```bash
git clone https://github.com/FyberLabs/s3r.ch.git
cd s3r.ch
npm ci
cp .env.example .env.local
```

Set `IDENTITY_SESSION_SECRET` in `.env.local` to at least 32 characters. Outside production, an unset secret uses the development fallback in `lib/identity/config.ts`. In production, verify returns 500 when the secret is missing or short. Wallet sign-in on the production image also needs `S3RCH_IDENTITY_BLOB_ACCOUNT` and `S3RCH_IDENTITY_BLOB_CONTAINER` ([docs/install-minimal.md](docs/install-minimal.md#identity-storage)).

Leave `S3RCH_OAUTH_ISSUER` and `S3RCH_LOGIN_PROVIDERS` unset for SIWE only. OIDC providers are backup sign-ins that bind to a wallet. Names, defaults, and which values are secrets are in [docs/configuration.md](docs/configuration.md).

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The feed is `/feed`. `npm run dev` leaves `NODE_ENV` unset, so the identity document is a local file and wallet sign-in can finish on `localhost`.

A production-shaped process (standalone Next and the Gun preload on one HTTP server):

```bash
npm run build
IDENTITY_SESSION_SECRET='replace-with-32-or-more-characters' \
  PORT=8080 HOSTNAME=0.0.0.0 npm start
```

`npm start` does not set `NODE_ENV`. On a workstation, leave it unset and the identity file stays local, same as `npm run dev`. The container image sets `NODE_ENV=production`.

Seed the public cache from live public sources. An empty or failed source writes nothing:

```bash
curl -sS -X POST http://localhost:3000/api/seed \
  -H "Authorization: Bearer dev-seed"
```

Use the port you started and the `SEED_SECRET` you set. When `SEED_SECRET` is unset and `NODE_ENV` is not production, the route accepts the call. In production an unset secret denies it.

Health check: `GET /api/health` returns HTTP 200 with `"status": "ok"` while the process is serving.

Optional loopback pull relay (not part of the image): `npm run pull-relay`. The unpacked extension is `extensions/s3rch-pull`. See [docs/pull-relay.md](docs/pull-relay.md).

## Stack

- **Next.js 16** and **React 19** (App Router, `output: "standalone"`)
- **GunDB** (same-process peer on `/gun`)
- **TypeScript**
- **Tailwind CSS**
- **Node 24** / npm

## Issues and review

Public intake is [GitHub Issues](https://github.com/FyberLabs/s3r.ch/issues/new/choose) (structured forms only). How to file, including the AI review path, is in [CONTRIBUTING.md](CONTRIBUTING.md). Hypermesh questions go to [https://hyperme.sh](https://hyperme.sh), not this backlog.

## Tests

```bash
npm test
```

That command checks the configuration reference and the packaged-release scripts, then runs `lib/*.test.ts` and `lib/identity/*.test.ts`.

## Deploy variables

Deploy (`.github/workflows/deploy.yml`) and the seed workflow use these settings. They belong to this repository's App Service path. A self-hosted copy of the image does not read `S3RCH_PANOPTICON_TENANT_ID`.

| Name | Required | Role |
| --- | --- | --- |
| `ACR_NAME` | yes | Container registry name. Set in the Deploy workflow env. |
| `ACR_LOGIN_SERVER` | yes | Registry host used to push the image and point App Service at it. Set in the Deploy workflow env. |
| `SEED_URL` | no | GitHub variable for `.github/workflows/seed.yml`. Unset posts to the prod `/api/seed` URL. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | no | GitHub variable passed as a Docker build-arg. Empty leaves WalletConnect off. |
| `S3RCH_PANOPTICON_TENANT_ID` | yes | The Panopticon marketplace tenant id the app uses, set as `PANOPTICON_TENANT_ID` on the App Service; it is an identifier, not a secret. |

`S3RCH_PANOPTICON_TENANT_ID` is required for the prod Deploy. Create it as a repository variable or a `prod` environment variable. Do not commit the value. Deploy checks it before checkout and image push. An unset or non-UUID value fails the job and does not clear the live App Service setting. The running app still treats a missing `PANOPTICON_TENANT_ID` as unconfigured.

Runtime settings — the session secret, Gun paths, login providers, TURN, outbound credentials, and each `PANOPTICON_*` hop — are in [docs/configuration.md](docs/configuration.md). Core without Panopticon is [docs/install-minimal.md](docs/install-minimal.md). Optional Panopticon login and hops are [docs/install-panopticon.md](docs/install-panopticon.md).
