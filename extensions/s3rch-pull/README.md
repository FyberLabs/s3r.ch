# s3r.ch pull (MV3 scaffold)

Unpacked Chromium extension. Fetches the same documented public hosts the lab seeder uses and hands bodies back to `/feed` over the `s3rch-pull` `v: 1` contract. Not a Chrome Web Store package. Not a general URL proxy. Direct browser-to-source still fails CORS in a naked tab.

Load unpacked from this directory (chrome://extensions → Developer mode). Page origin must be `https://s3r.ch` or `http://localhost` / `http://127.0.0.1`. `/api/ingest` stays the fallback when this is not installed.

Contract, allowlist, and handshake: [docs/pull-relay.md](../../docs/pull-relay.md).
