# s3r.ch

[s3r.ch](https://s3r.ch) is a recovering Fyber Labs lab domain. It is not a live search product.

Sister sites: [Fyber Labs](https://fyberlabs.com), [Hypermesh / Hyperme.sh](https://hyperme.sh), [Tennessee Windage](https://tennesseewindage.com).

## Stack

- **Next.js 16** + **React 19** (App Router, `output: "standalone"`)
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
