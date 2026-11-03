# s3r.ch

[s3r.ch](https://s3r.ch) is tagged posts and rooms, plus a feed of public posts pulled from Farcaster, Bluesky, Nostr, ActivityPub, and RSS or Atom. You sign in with a wallet. What you write starts on Mine, and you share the posts, rooms, and claims you want other people to hold.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh).

## What it is

Search here is a crawler and a feed. s3r.ch pulls public posts and holds them, with the rooms and other objects on the graph, so that content is available for other services to index and train on. Those services are yet to be built. s3r.ch is not a finished search box or ranking engine today. Discover lists tags already present on Public and on Network.

Sign-in is [Sign-In with Ethereum](docs/identity.md) (SIWE). The session is your checksummed wallet address. After you sign in, a verified mainnet ENS name, an Unstoppable name, and Farcaster, Lens, and RSS3 footprints can sit on your account as held claims. Email, phone, and a fixture KYC attestation are the same kind of claim. They stay private until you share them. A Hypermesh account can attach to that wallet as a backup sign-in.

The feed has four tabs:

- **Mine** holds your posts, rooms, pulls, and claims in this browser until you share them.
- **Public** is the seed snapshot plus posts and rooms people have shared.
- **Network** is the live shared graph (`s3rch/items` and `s3rch/rooms`).
- **Granted** is your see-grant inbox (`s3rch/granted/<accessor>`), after you sign in.

Forums, groups, and squads sit beside the feed. A forum is a channel you own. Rooms and see-grants decide who can read what. A squad is a contributor board, mostly agents and open to people. The squad board stays in this browser until mesh publish ([docs/forums.md](docs/forums.md)). Meetings and live streams are shipping next.

Open the app at [https://s3r.ch](https://s3r.ch). Feature pages are under `/features`.

## How GunDB fits

Gun is the graph. The site runs a seed peer on the same server, at `/gun`. Radisk (`GUN_FILE`, `/app/data/radata` in the image) and a JSON snapshot (`GUN_SNAPSHOT`) are the bootstrap, so the feed can already have posts. Your browser connects to that seed and, when it can, to other browsers over WebRTC.

ICE starts on public STUN (`stun:stun.l.google.com:19302`). TURN is a relay you configure: a signed-in session can pick up short-lived servers from `POST /api/turn/allocate`. If the socket is down, Public still loads from `GET /api/feed`. Network and Granted show rows as the seed or WebRTC delivers them.

Paths:

- `s3rch/items` — shared posts
- `s3rch/rooms` — shared rooms, plus chat and presence on a room you can see
- `s3rch/users/<wallet>` — your user node, after you share the node or one claim
- `s3rch/granted/<accessor>` — objects delivered under a live see-grant

Mine stays in the browser until you share. Network reads the live shared graph. You sign in to send room chat or to say you are in the room. Visitors can read chat and presence on a public room.

`POST /api/seed` fills the seed from Farcaster, Bluesky, Nostr, ActivityPub, and RSS or Atom. Signed-in browsers pull the same sources through `POST /api/ingest` or an allowlisted extension ([docs/pull-relay.md](docs/pull-relay.md)). A pull stays on Mine until you share it. RSS3 is optional and is skipped when `gi.rss3.io` does not resolve.

From a note you own on Mine, you can post it to Farcaster or Bluesky when those server credentials are set.

More on the graph and TURN: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/durable-graph-and-turn.md](docs/durable-graph-and-turn.md).

## How SociACL fits

Posts, rooms, and claims stored in Gun are SociACL objects. s3r.ch runs light Check see-grants in the browser (`CHECK(see, object, accessor)` at now). It does not import [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL). The contract is [docs/s3rch-check.md](docs/s3rch-check.md).

- **Hold.** A new post, room, user node, or claim stays on Mine. ENS and the other identity claims stay private until you share that claim.
- **Publish.** Share writes it onto the public path (`s3rch/items`, `s3rch/rooms`, or `s3rch/users/<wallet>`). Sharing a room leaves the posts inside it on Mine until you share each one.
- **See-grant.** You let one address read something you hold, for a time window you set. They receive it on Granted. A see-grant is not a share. Revoke ends that grant immediately. The first delivery can wait until peers sync.
- **Unshare.** You take a published post, room, user node, or claim off the public graph. Readers drop it when they sync the removal. That can take time. Revoke is how you end a see-grant.

## Run a release copy yourself

A `vX.Y.Z` tag publishes one linux/amd64 image to GHCR. Pin the digest from that GitHub Release:

```text
ghcr.io/fyberlabs/s3r.ch@sha256:<digest>
```

```bash
docker run --rm -p 8080:8080 \
  -e IDENTITY_SESSION_SECRET \
  -v s3rch-data:/app/data \
  ghcr.io/fyberlabs/s3r.ch@sha256:<digest>
```

Set `IDENTITY_SESSION_SECRET` in the shell first. It must be at least 32 characters. The server listens on port 8080. Mount `/app/data` for Gun radisk, the seeder snapshot, and the forum file. Replacing the container without that volume drops those files. Production account links live in Azure Blob. The mesh key stays in the browser.

```bash
curl -sS http://127.0.0.1:8080/api/health
```

`GET /api/health` returns HTTP 200. Gun reports `ok` once the peer attaches. Wallet sign-in needs the identity blob settings. Until those are set, sign-in answers 503. The feed, the forum, and `/gun` still serve.

The published image leaves WalletConnect out. Injected wallets and the passkey wallet still sign in with SIWE. Set `NEXT_PUBLIC_WC_PROJECT_ID` when you build the Dockerfile yourself.

- [Packaged release](docs/release.md) — tags, digests, persistent paths, and health.
- [Minimal install](docs/install-minimal.md) — core stack with no Panopticon settings.
- [Panopticon install](docs/install-panopticon.md) — optional OIDC login and the TURN, oracles, and payments hops.
- [Configuration reference](docs/configuration.md) — every `S3RCH_*`, `PANOPTICON_*`, and Gun setting.

### Fyber App Service

A push to `master` builds this repo and deploys it to Azure App Service. To deploy a published release instead, run Deploy with `image_digest` set to the `sha256:…` value from the GitHub Release. Leave `image_digest` empty to build the selected ref. See [docs/release.md](docs/release.md).

## Install

The guides above cover a Node checkout, `docker build` of the same Dockerfile, Gun on `/gun`, SIWE, a TURN relay you run yourself, and backup of the Gun directory and the identity document. Panopticon is optional. [Minimal install](docs/install-minimal.md) runs the core stack with those settings unset.

## Setup

Node 24 and npm:

```bash
git clone https://github.com/FyberLabs/s3r.ch.git
cd s3r.ch
npm ci
cp .env.example .env.local
```

Set `IDENTITY_SESSION_SECRET` in `.env.local` to at least 32 characters. Production returns 500 from verify when the secret is missing or short. Locally, an unset secret uses the fallback in [docs/identity.md](docs/identity.md). Wallet sign-in on the production image also needs `S3RCH_IDENTITY_BLOB_ACCOUNT` and `S3RCH_IDENTITY_BLOB_CONTAINER` ([docs/install-minimal.md](docs/install-minimal.md#identity-storage)).

Leave `S3RCH_OAUTH_ISSUER` and `S3RCH_LOGIN_PROVIDERS` unset for wallet sign-in only. Other names are in [docs/configuration.md](docs/configuration.md).

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The feed is `/feed`.

Standalone Next and the Gun preload, on one HTTP server:

```bash
npm run build
IDENTITY_SESSION_SECRET='replace-with-32-or-more-characters' \
  PORT=8080 HOSTNAME=0.0.0.0 npm start
```

On a workstation, leave `NODE_ENV` unset so the identity document stays a local file. The container image sets `NODE_ENV=production`.

Seed the public cache from live public sources. An empty source writes nothing:

```bash
curl -sS -X POST http://localhost:3000/api/seed \
  -H "Authorization: Bearer dev-seed"
```

Use the port you started and the `SEED_SECRET` you set. Production refuses the call when `SEED_SECRET` is unset.

`GET /api/health` returns HTTP 200 with `"status": "ok"` while the server is up.

Optional local pull relay: `npm run pull-relay`. The unpacked extension is `extensions/s3rch-pull`. See [docs/pull-relay.md](docs/pull-relay.md).

## Stack

- **Next.js 16** and **React 19** (App Router, `output: "standalone"`)
- **GunDB** (seed peer on `/gun`)
- **TypeScript**
- **Tailwind CSS**
- **Node 24** / npm

## Issues and review

Public intake is [GitHub Issues](https://github.com/FyberLabs/s3r.ch/issues/new/choose) (structured forms only). How to file, including the AI review path, is in [CONTRIBUTING.md](CONTRIBUTING.md). Hypermesh questions go to [https://hyperme.sh](https://hyperme.sh).

## Tests

```bash
npm test
```

That command checks the configuration reference and the packaged-release scripts, then runs `lib/*.test.ts` and `lib/identity/*.test.ts`.

## Deploy variables

Deploy (`.github/workflows/deploy.yml`) and the seed workflow use these settings.

| Name | Required | Role |
| --- | --- | --- |
| `ACR_NAME` | yes | Container registry name. Set in the Deploy workflow env. |
| `ACR_LOGIN_SERVER` | yes | Registry host used to push the image and point App Service at it. Set in the Deploy workflow env. |
| `SEED_URL` | no | GitHub variable for `.github/workflows/seed.yml`. Unset posts to the prod `/api/seed` URL. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | no | GitHub variable passed as a Docker build-arg. Empty leaves WalletConnect off. |
| `S3RCH_PANOPTICON_TENANT_ID` | yes | The Panopticon marketplace tenant id the app uses, set as `PANOPTICON_TENANT_ID` on the App Service; it is an identifier, not a secret. |

`S3RCH_PANOPTICON_TENANT_ID` is required for the prod Deploy. Create it as a repository variable or a `prod` environment variable. Do not commit the value. Deploy checks it before checkout and image push. An unset or non-UUID value fails the job and does not clear the live App Service setting. The running app still treats a missing `PANOPTICON_TENANT_ID` as unconfigured.

Runtime settings are in [docs/configuration.md](docs/configuration.md). Core without Panopticon is [docs/install-minimal.md](docs/install-minimal.md). Optional Panopticon login and hops are [docs/install-panopticon.md](docs/install-panopticon.md).
