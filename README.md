# s3r.ch

[s3r.ch](https://s3r.ch) is a Fyber Labs lab domain. It is not a live search product.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh), [Tennessee Windage](https://tennesseewindage.com).

The public [lab feed](/feed) is a GunDB graph. RSS3 Data Sublayer activity is seeded into Gun on a cadence. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
```

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Production-shaped process (standalone Next + Gun preload on one HTTP server):

```bash
npm run build
PORT=8080 HOSTNAME=0.0.0.0 npm start
```

Seed the public graph (writes into Gun, does not invent rows):

```bash
curl -X POST http://localhost:8080/api/seed \
  -H "Authorization: Bearer dev-seed"
```

Health check: `GET /api/health` returns `{ "status": "ok" }`.

## Tests

```bash
npm test
```
