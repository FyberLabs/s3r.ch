# s3r.ch

Public landing for [s3r.ch](https://s3r.ch): research on crypto, contracts, social search, and trust.

This is a Fyber Labs research site (Chris Hamilton's lab), currently recovering. It is not a live search product.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh), [Tennessee Windage](https://tennesseewindage.com).

## Session management

![Session Use Case](http://www.plantuml.com/plantuml/proxy?cache=no&src=https://raw.githubusercontent.com/FyberLabs/s3r.ch/master/session-uc.wsd&max-age=0)

## Group selection

![Group User Case](http://www.plantuml.com/plantuml/proxy?cache=no&src=https://raw.githubusercontent.com/FyberLabs/s3r.ch/master/group-uc.wsd)

The original PlantUML sources (`session-uc.wsd`, `group-uc.wsd`) stay at the repository root. The site also serves copies from `/docs` and renders them on `/research`.

`/feed` is a public RSS3-backed activity board (popular vs novel). It reads documented GI network/platform activities. It is not a social network, not a live search product, and not financial advice. If RSS3 is down, the board stays empty.

## Stack

- **Next.js 15** (App Router, `output: "standalone"`)
- **TypeScript**
- **Tailwind CSS**
- **Node 24** / npm

## Setup

```bash
npm ci
```

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build and run

```bash
npm run build
PORT=8080 HOSTNAME=0.0.0.0 npm start
```

Health check: `GET /api/health` returns `{ "status": "ok" }`.
