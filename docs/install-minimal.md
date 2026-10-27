# Minimal install

Run s3r.ch with the core stack and no Panopticon settings. Gun, the public feed, the forum, SIWE, and a browser Gun SEA key work in this mode. Optional OIDC providers and an optional TURN relay are part of this mode. Panopticon login and the Panopticon hops are [install-panopticon.md](install-panopticon.md).

Account-link storage is [identity-storage.md](identity-storage.md). Login behavior is [identity.md](identity.md). TURN background is [durable-graph-and-turn.md](durable-graph-and-turn.md).

Published images and the digest pin are [release.md](release.md). The steps below are a Node checkout and `docker build` of the same `Dockerfile`.

## Clone, build, and run

Node 24 and npm. This is the path that completes SIWE on a clean machine: `npm run dev` keeps `NODE_ENV` off production, so the identity document is a local file and wallet sign-in can finish on `localhost`.

```bash
git clone https://github.com/FyberLabs/s3r.ch.git
cd s3r.ch
npm ci
cp .env.example .env.local
```

Set `IDENTITY_SESSION_SECRET` in `.env.local` to a string of at least 32 characters. Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The feed is `/feed`.

```bash
curl -sS http://localhost:3000/api/health
```

The process answers HTTP 200. With no `PANOPTICON_*` variables, `dependencies.panopticon.status` is `not-configured`. See [Health](#health).

A production-shaped process (standalone Next and the Gun preload on one HTTP server):

```bash
npm run build
IDENTITY_SESSION_SECRET='replace-with-32-or-more-characters' \
  PORT=8080 HOSTNAME=0.0.0.0 npm start
```

`npm start` runs `node -r ./gun-preload.cjs .next/standalone/server.js`. It does not set `NODE_ENV`. Leave `NODE_ENV` unset on a workstation and the identity document stays the local file, same as `npm run dev`. The image sets `NODE_ENV=production`. Match that on a shared host with `NODE_ENV=production`; identity storage is then Azure Blob, under [Identity storage](#identity-storage), and `IDENTITY_SESSION_SECRET` is required.

Seed the public cache (live public sources only; an empty source writes nothing):

```bash
curl -sS -X POST http://localhost:3000/api/seed \
  -H "Authorization: Bearer dev-seed"
```

Use the port you actually started, and the `SEED_SECRET` you set. When `SEED_SECRET` is unset and `NODE_ENV` is not production, the seed route accepts the call. In production an unset `SEED_SECRET` denies it.

## Docker

Build from this repo. The image listens on 8080, sets `NODE_ENV=production`, `GUN_FILE=/app/data/radata`, and `GUN_SNAPSHOT=/app/data/snapshot.json`, and runs as uid 1001 (`nextjs`).

```bash
docker build -t s3rch:local .
mkdir -p data && sudo chown 1001:1001 data
docker run --rm -p 8080:8080 \
  -e IDENTITY_SESSION_SECRET \
  -e SEED_SECRET \
  -u 1001:1001 \
  -v "$PWD/data:/app/data" \
  s3rch:local
```

Pass the secrets in the environment. Do not write them into the image. A bind mount must be writable by uid 1001. A named volume is the same Gun directory:

```yaml
services:
  s3rch:
    build: .
    ports:
      - "8080:8080"
    environment:
      IDENTITY_SESSION_SECRET: ${IDENTITY_SESSION_SECRET}
      SEED_SECRET: ${SEED_SECRET}
    volumes:
      - s3rch-data:/app/data
volumes:
  s3rch-data:
```

```bash
curl -sS http://127.0.0.1:8080/api/health
```

The volume keeps Gun radisk and `snapshot.json` when the container is replaced. In this image the identity document is the Azure Blob named below, so the volume does not hold account links. `GET /api/health` is still 200. `dependencies.gun.status` is `ok` once the peer attaches. `dependencies.panopticon.status` is `not-configured`. `dependencies.identity.status` becomes `unavailable` until `S3RCH_IDENTITY_BLOB_ACCOUNT`, `S3RCH_IDENTITY_BLOB_CONTAINER`, and a managed identity that can write that container are set. Wallet sign-in then answers 503 until that check passes.

SIWE accepts the hostnames `s3r.ch`, `localhost`, and `127.0.0.1` (a port on those names is fine). OAuth callbacks are accepted only for `http://localhost:3000`, `http://127.0.0.1:3000`, `https://s3r.ch`, and `https://www.s3r.ch`, path `/api/identity/oauth/callback`. A docker publish on port 8080 can serve the site and `/gun` on `localhost`. Wallet sign-in on that port still needs a working identity store. OIDC on `localhost` uses port 3000.

## Gun relay

`gun-preload.cjs` attaches one Gun peer to the HTTP server before `listen`. The WebSocket path is `/gun` on the same origin and port as the site. `multicast` and `axe` are off. The peer list in the server process is empty: this process does not dial another relay. Browsers on this origin connect to `/gun`. Browser WebRTC (`gun/lib/webrtc`) can connect those browsers to each other. STUN is `stun:stun.l.google.com:19302`. STUN is not TURN.

| Setting | Default | What it is |
| --- | --- | --- |
| `GUN_FILE` | `./data/radata`, or `/app/data/radata` in the image | Directory. Gun creates it. Radisk for this process. |
| `GUN_SNAPSHOT` | `./data/snapshot.json`, or `/app/data/snapshot.json` in the image | JSON cache of seeder public items. |

Point another s3r.ch browser at this site and it uses this `/gun` peer. There is no setting that adds a remote Gun URL to the server process. Two processes must not write the same `GUN_FILE` directory.

The forum file (`S3RCH_FORUM`, default `data/forum.json`) and the snapshot are caches on that disk. An App Service recycle that drops container disk drops them. The volume above is how a Docker host keeps the Gun directory.

## Identity storage

The identity document is version-1 JSON:

- `people[]` — linked credentials on one record. Each record has `handles` (`kind: "wallet"` with a checksummed address, and `kind: "oauth"` with a subject). `ageConfirmedAt` is the ISO time that person confirmed they are at least 18. The `owner` field is the first linked wallet address on that record.
- `oauthAge` — an 18+ confirmation for an OIDC subject that is not linked to a wallet yet.
- `providerIssuers` — `{"<provider id>": "<issuer>"}`, written the first time that provider logs someone in.

The document has no provider tokens, no SEA `pub` / `priv` / `epriv`, and no TURN secret. Gun is a different store.

The mesh identity is the Gun SEA public key in the browser. Wallet addresses and OIDC subjects in this document are linked credentials for sign-in and for finding that key again. See [Gun SEA identity](#gun-sea-identity).

### Local file

When `NODE_ENV` is not production, the file is `S3RCH_IDENTITY_LINKS` or `data/identity-links.json`. A missing file starts as `{"v":1,"people":[]}`. Production does not read this path.

Stop the process before copying the file. A second development process refuses to write while another write is open. If a write stops halfway, recovery of the writer directory is in [identity-storage.md](identity-storage.md).

### Azure Blob

Production reads two application settings and no storage connection string:

| Setting | Secret | Rule |
| --- | --- | --- |
| `S3RCH_IDENTITY_BLOB_ACCOUNT` | no | 3–24 lowercase letters and digits. Endpoint `https://<account>.blob.core.windows.net`. |
| `S3RCH_IDENTITY_BLOB_CONTAINER` | no | Container name. The container must already exist and be private. The app does not create it. |

The blob name is `identity-links.json`. Auth is `DefaultAzureCredential` limited to the app's managed identity. A system-assigned identity needs no extra setting. A user-assigned identity also needs `AZURE_CLIENT_ID` (the identity's client id, not a secret). That identity needs **Storage Blob Data Contributor** on the account or the container. A missing blob is created as `{"v":1,"people":[]}`.

`S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS` is how long the preload waits for the blob worker to start. Default `60000`. An integer from `1000` through `120000` is honored. Anything else stays `60000`. The background check then has additional time for the blob call. The site keeps serving during that wait.

### When storage is down

Feed, forum, and `/gun` stay up. `GET /api/health` stays HTTP 200.

- Unusable account, container, or identity: `dependencies.identity.status` is `unavailable`. Account linking, OIDC link writes, age confirmation, and wallet sign-in return HTTP 503 with `Retry-After: 60`, because sign-in reads the stored age confirmation.
- A blob that is not valid version-1 JSON: status `invalid`, same 503. The blob is left as it is. Restore a known-good copy. The process does not overwrite a document it cannot parse.
- The check retries from 5 seconds up to 5 minutes. When it passes, writes work again with no restart.

## Gun SEA identity

On `http://localhost:3000/feed` after `npm run dev`:

1. Connect a wallet and sign the SIWE message (`Sign in to s3r.ch`). The first time, confirm the 18+ prompt. That time is stored on the identity document. The session cookie carries the checksummed address so the server can recognize that sign-in. The address is a linked credential.
2. The browser then calls Gun SEA `pair()` and creates a P-256 key in this origin. The mesh identity is that SEA `pub`.
3. The wallet signs a short statement that this `pub` belongs to this address. The pair and that signature stay in origin IndexedDB (`s3rch-identity` / `mesh-keys`). They are not written to Gun and not sent to the identity document.
4. Sign-in again on this origin reuses the stored pair. A passkey PRF wrap and a paper string (`s3rch-wrap-v1:…`) recover that same pair on this browser. They are recovery of the SEA key. They are not a second identity and not the session.

SEA `priv` and `epriv` stay in that IndexedDB record. Copying server disk does not copy them. A new browser creates a new pair until the person unwraps a wrapped copy they still hold.

## Login providers

SIWE is always on. `GET /api/identity/providers` lists ids and labels. `GET /api/identity/oauth/start?provider=<id>` starts one OIDC provider.

Leave `S3RCH_OAUTH_ISSUER` unset, and leave `S3RCH_LOGIN_PROVIDERS` unset, for SIWE only.

`S3RCH_LOGIN_PROVIDERS` is the whole list when it is set: a JSON array. Include the SIWE entry. Issuer and endpoint URLs are `https`, or `http` on `localhost` / `127.0.0.1`. No userinfo in the URL, no query, no fragment. An invalid entry is dropped.

Endpoints default to the Keycloak layout under the issuer (`/protocol/openid-connect/auth`, `/token`, and `/certs`). An IdP that uses other paths sets `authorizationEndpoint`, `tokenEndpoint`, and `jwksUri`. There is no client secret. The client is public PKCE. Default `clientId` is `s3rch-web` when the field is omitted.

Example for a directory that is not Panopticon. Register the redirect URI `http://localhost:3000/api/identity/oauth/callback` on that client for local sign-in.

```json
[
  { "id": "siwe", "kind": "siwe", "label": "Wallet" },
  {
    "id": "directory",
    "kind": "oidc",
    "label": "Directory",
    "issuer": "https://auth.example.org/realms/apps",
    "clientId": "s3rch-web"
  }
]
```

Put that JSON in `S3RCH_LOGIN_PROVIDERS` as a single environment value.

Account keys for a provider subject (`lib/identity/providers.ts`):

- Provider id `panopticon`, subject with no `:`, no whitespace, not an Ethereum address, at most 256 characters: the key is the subject itself (a bare id).
- Every other provider id: `<provider id>:<encodeURIComponent(subject)>`.
- When that string would pass 256 characters: `<provider id>:%h` plus the base64url SHA-256 of the subject.

The first successful login with a provider pins `providerIssuers[<id>]` to that issuer. A later login whose configured issuer differs is refused and logged. Approving a move is `S3RCH_LOGIN_PROVIDER_ISSUER_MOVE`, documented end to end in [install-panopticon.md](install-panopticon.md#issuer-pinning). The account key does not change when the issuer pin moves.

## TURN

Unset `S3RCH_TURN_URLS` and the signed-in allocate route returns 503 `turn-unconfigured`. Browsers stay on STUN plus `/gun`.

For a relay you run, set server-side variables. Keep the secret in a secret store. Never `NEXT_PUBLIC_*`. Never Gun. Never the browser.

| Setting | Default | Secret | Role |
| --- | --- | --- | --- |
| `S3RCH_TURN_URLS` | unset | no | Comma-separated `stun:`, `turn:`, and `turns:` URLs. Public hostnames. Loopback and private addresses are dropped. |
| `S3RCH_TURN_SECRET` | unset | yes | Shared secret. Required when a `turn:` or `turns:` URL is listed. Same value as coturn `static-auth-secret`. |
| `S3RCH_TURN_TTL_SEC` | `3600` | no | Lifetime in seconds. Integers from 60 through 86400. Anything else stays 3600. |

Each signed-in request mints a TURN REST credential: username `<expiry unix seconds>:<random id>`, credential `base64(HMAC-SHA1(S3RCH_TURN_SECRET, username))`. The secret stays on the server.

`S3RCH_TURN_INSECURE_STATIC_CREDENTIAL` stays unset. Together with `S3RCH_TURN_USERNAME` and `S3RCH_TURN_CREDENTIAL` it would send one fixed credential to every signed-in browser. Leave it off.

coturn, on a host with a public name such as `turn.example.org` (DNS only; UDP TURN does not pass an HTTP reverse proxy):

```
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=REPLACE_WITH_S3RCH_TURN_SECRET
realm=turn.example.org
server-name=turn.example.org
no-multicast-peers
min-port=49160
max-port=49200
```

Open UDP 3478 and the relay range you chose. `turns:` also needs TLS on 5349. Then:

```
S3RCH_TURN_URLS=turn:turn.example.org:3478,turns:turn.example.org:5349
S3RCH_TURN_SECRET=REPLACE_WITH_S3RCH_TURN_SECRET
S3RCH_TURN_TTL_SEC=3600
```

`dependencies.panopticon.staticTurn` becomes `configured`. `dependencies.panopticon.services.turn` stays `not-configured` until the Panopticon allocate hop is configured. The static relay is this server's own secret, not that hop.

Verify after a SIWE session on `/feed` (the route is 401 with no session cookie):

```js
fetch("/api/turn/allocate", { method: "POST", credentials: "include" })
  .then((response) => response.json())
  .then(console.log);
```

A working relay returns HTTP 200 and `iceServers` whose `turn:` or `turns:` URL matches `S3RCH_TURN_URLS`, with a username shaped `<expiry>:<id>`. In `chrome://webrtc-internals`, a connection that had to use the relay shows a candidate of type `relay`. If the socket can open with STUN or `/gun` alone, a relay candidate may never appear; the allocate JSON is still the check that this server minted a credential.

## Health

`GET /api/health` is HTTP 200 while the process serves. It does not hide a down integration inside a failed status code.

```json
{
  "status": "ok",
  "dependencies": {
    "gun": { "status": "ok" },
    "identity": {
      "status": "ok",
      "writable": true,
      "reason": null,
      "checkedAt": "2026-01-01T00:00:00.000Z",
      "nextRetryAt": null
    },
    "panopticon": {
      "status": "not-configured",
      "services": {
        "payments": { "status": "not-configured" },
        "oracles": { "status": "not-configured" },
        "turn": { "status": "not-configured" }
      },
      "staticTurn": "not-configured"
    }
  }
}
```

`gun.status` is `ok` when the preload attached the peer, and `not-attached` otherwise. Identity statuses include `ok`, `unavailable`, `invalid`, `checking`, and `unchecked`. Panopticon service statuses are `not-configured`, `configured` (settings present, no hop yet), `ok` (last hop succeeded), and `unreachable` (last hop failed). The parent `panopticon.status` is `not-configured` when payments, oracles, and the Panopticon turn hop are all `not-configured`. It is `degraded` when any of those is `unreachable`.

## Settings

Secrets are server-side only. Never `NEXT_PUBLIC_*` for a secret. `NEXT_PUBLIC_WC_PROJECT_ID` is public and is inlined at `next build` (Docker build-arg of the same name). Empty leaves WalletConnect out of the bundle. The checked list of `S3RCH_*`, `PANOPTICON_*`, and Gun settings is [configuration.md](configuration.md).

| Name | Required | Default | Secret |
| --- | --- | --- | --- |
| `IDENTITY_SESSION_SECRET` | yes in production | development fallback in `lib/identity/config.ts` when unset and not production; a short value is always rejected | yes |
| `SEED_SECRET` | yes in production if you call `/api/seed` | unset allows the call only outside production | yes |
| `GUN_FILE` | no | `./data/radata` (`/app/data/radata` in the image) | no |
| `GUN_SNAPSHOT` | no | `./data/snapshot.json` (`/app/data/snapshot.json` in the image) | no |
| `S3RCH_IDENTITY_LINKS` | no | `data/identity-links.json` outside production | no; it holds linked credentials |
| `S3RCH_IDENTITY_BLOB_ACCOUNT` | yes for production sign-in | unset | no |
| `S3RCH_IDENTITY_BLOB_CONTAINER` | yes for production sign-in | unset | no |
| `AZURE_CLIENT_ID` | only for a user-assigned managed identity | unset (system-assigned) | no |
| `S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS` | no | `60000` | no |
| `S3RCH_OAUTH_ISSUER` | no | unset means SIWE only, unless `S3RCH_LOGIN_PROVIDERS` is set | no |
| `S3RCH_OAUTH_CLIENT_ID` | no | `s3rch-web` | no |
| `S3RCH_OAUTH_WALLET_URL` | no | unset | no |
| `S3RCH_LOGIN_PROVIDERS` | no | the SIWE entry plus one provider id `panopticon` built from `S3RCH_OAUTH_*` when the issuer is set | no |
| `S3RCH_LOGIN_PROVIDER_ISSUER_MOVE` | no | unset | no |
| `S3RCH_TURN_URLS` | no | unset | no |
| `S3RCH_TURN_SECRET` | when a `turn:` URL is set | unset | yes |
| `S3RCH_TURN_TTL_SEC` | no | `3600` | no |
| `S3RCH_TURN_INSECURE_STATIC_CREDENTIAL` | no | off | no |
| `S3RCH_TURN_USERNAME` | only with the insecure flag | unset | yes |
| `S3RCH_TURN_CREDENTIAL` | only with the insecure flag | unset | yes |
| `NEXT_PUBLIC_WC_PROJECT_ID` | no | empty | no |
| `UNSTOPPABLE_API_KEY` | no | empty; on-chain lookup only | yes |
| `CONFIRM_SEND_URL` | no | empty; live send stays unconfigured. Outside production the fixture code `000000` is used unless `CONFIRM_FIXTURE=0` | yes |
| `CONFIRM_FIXTURE` | no | fixture on outside production | no |
| `KYC_ISSUER_URL` | no | fixture issuer | no |
| `FARCASTER_FID`, `FARCASTER_SIGNER_KEY` | no | empty; Farcaster outbound fails closed | signer key is a secret |
| `FARCASTER_HUB_AUTH`, `FARCASTER_HUB_BASE` | no | hub auth empty | hub auth is a secret |
| `ATPROTO_IDENTIFIER`, `ATPROTO_APP_PASSWORD` | no | empty; Bluesky outbound fails closed | app password is a secret |
| `ATPROTO_PDS_BASE` | no | `https://bsky.social` | no |
| `S3RCH_FORUM` | no | `data/forum.json` | no |
| `PORT` | no | `3000` for `next dev`; `8080` in the image | no |
| `HOSTNAME` | no | `0.0.0.0` in the image | no |

Leave every `PANOPTICON_*` name unset for this mode. `S3RCH_IDENTITY_STORAGE_ROOT` and `WEBSITES_ENABLE_APP_SERVICE_STORAGE` are not read for the identity document.

## Without Panopticon

With those names unset:

- `dependencies.panopticon.status` is `not-configured`, and payments, oracles, and the Panopticon turn hop are each `not-configured`.
- `POST /api/oracles/attest` returns 503 `oracles-unconfigured`. Browser SIWE, ENS, and ERC-1271 still run in the client.
- `POST /api/payments/receipt` and `POST /api/payments/intent` return 503 `payments-unconfigured`.
- `POST /api/turn/allocate` uses `S3RCH_TURN_*` when that relay is set, and otherwise returns 503 `turn-unconfigured` (STUN and `/gun` remain).
- OIDC exists only for providers you put in `S3RCH_LOGIN_PROVIDERS` or via `S3RCH_OAUTH_ISSUER`. Unset means SIWE only.

Gun, `/feed`, the forum, Check see-grants, Mine / Network / Granted, and the local SEA key do not call Panopticon.

## Backup and restore

Stop writers first so the copy is a single version of each file.

**Identity, development.** Copy `data/identity-links.json` (or `S3RCH_IDENTITY_LINKS`). Restore by putting that file back before the next start. The SEA key is not in the file. Restoring it brings back linked wallets, OIDC subjects, age confirmations, and issuer pins.

**Identity, production.** Copy the blob `identity-links.json` out of the private container (download, or a storage snapshot of that blob). Upload it back to the same blob name to restore. A document the app cannot parse is not overwritten; replace it with the saved copy and wait for the health check to flip `identity` to `ok`.

**Gun.** Copy the `GUN_FILE` directory and the `GUN_SNAPSHOT` file. Restore both into the same paths, then start one process. That restores the radisk and the seeder snapshot that were on disk. Shared mesh state that never reached this peer is not in the copy. `POST /api/seed` fills seeder public items again; it does not restore account links or browser SEA keys.

Redeploying the image without these copies drops radisk and the snapshot on ephemeral disk. The identity blob survives a new container when the two blob settings still point at it.
