# s3r.ch

[s3r.ch](https://s3r.ch) is a Fyber Labs lab domain. It is not a live search product.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh), [Tennessee Windage](https://tennesseewindage.com).

The public [lab feed](/feed) is a GunDB graph. This slice’s seeder and `GET /api/feed` snapshot are a bootstrap cache (so the graph is not empty and App Service is not the chat server); the end-state is a mostly browser-to-browser Gun mesh. The public seeder pulls live Farcaster Hubble HTTP, ATProto AppView, and RSS/Atom. RSS3 Global Indexer (`gi.rss3.io`) is optional and currently has no public DNS — a GI failure does not empty the other sources or invent rows. Gun-stored items and claims are native SociACL objects (Check lives in SociACL, not this Next app); URL fetches are handoffs, not grants. `/feed` can Sign in with Ethereum (SIWE + cookie session). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/identity.md](docs/identity.md).

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
```

`IDENTITY_SESSION_SECRET` must be at least 32 characters. It is required in production (verify returns 500 if missing). Locally, an unset secret falls back to a documented default — see [docs/identity.md](docs/identity.md). Operator step: set it on App Service (Key Vault later). Do not add a WalletConnect project id.

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
