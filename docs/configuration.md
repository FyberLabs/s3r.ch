# Configuration reference

This is the list of every `S3RCH_*`, `PANOPTICON_*`, and `GUN_*` setting the server or the deploy scripts read. `scripts/check-config-reference.mjs` fails when code reads a name that is not in the table, and when the table names a setting the scanned code does not read.

Operator walkthroughs, including SIWE, TURN, backup, and optional Panopticon login, are [install-minimal.md](install-minimal.md) and [install-panopticon.md](install-panopticon.md). Published images are [release.md](release.md).

Panopticon is optional at runtime. With every `PANOPTICON_*` name unset, the process still serves and `GET /api/health` reports `dependencies.panopticon.status` as `not-configured`.

Identity in the browser is a Gun SEA public key. Wallet addresses and OAuth subjects are linked credentials on the identity document. They are not that key. The document format is in [install-minimal.md](install-minimal.md#identity-storage).

Settings outside this table (`IDENTITY_SESSION_SECRET`, `SEED_SECRET`, `PORT`, `HOSTNAME`, `NODE_ENV`, and the outbound and confirm names) are in the install guide. Production requires `IDENTITY_SESSION_SECRET` (32 characters or more) for session routes. The image sets `PORT=8080`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

| Setting | Required | Default | Secret | What it does |
| --- | --- | --- | --- | --- |
| `GUN_FILE` | no | `data/radata` under the process cwd; the image sets `/app/data/radata` | no | Directory for this process's Gun radisk. Create it on a persistent volume. |
| `GUN_SNAPSHOT` | no | `data/snapshot.json` under the cwd; the image sets `/app/data/snapshot.json` | no | JSON cache of seeder public items. |
| `PANOPTICON_API_KEY` | no | unset | yes | `X-Api-Key` for the TURN, oracles, and payments hops. All three of this key, `PANOPTICON_TENANT_ID`, and that hop's base must be set or the hop stays unconfigured. |
| `PANOPTICON_ORACLES_BASE` | no | unset | no | Attest origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `PANOPTICON_PAYMENTS_BASE` | no | unset | no | Payments origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `PANOPTICON_TENANT_ID` | no | unset | no | Marketplace tenant UUID sent as `X-Tenant-ID`. An identifier. The process treats a missing value as unconfigured. |
| `PANOPTICON_TURN_BASE` | no | unset | no | TURN allocate origin, or that origin plus the `/api/v1` prefix the hop already joins. |
| `S3RCH_FORUM` | no | `data/forum.json` under the cwd (`/app/data/forum.json` in the image) | no | Forum ledger file. Same disk as the Gun directory. |
| `S3RCH_IDENTITY_BLOB_ACCOUNT` | no for boot; required for production identity writes | unset | no | Azure Storage account name (3–24 lowercase letters and digits). |
| `S3RCH_IDENTITY_BLOB_CONTAINER` | no for boot; required for production identity writes | unset | no | Private blob container that already exists. The blob name is `identity-links.json`. |
| `S3RCH_IDENTITY_LINKS` | no | `data/identity-links.json` when `NODE_ENV` is not production | no | Development identity file. Production does not read this path. |
| `S3RCH_IDENTITY_WORKER_START_TIMEOUT_MS` | no | `60000` | no | How long the blob worker may take to start. An integer from 1000 through 120000 is used; anything else stays 60000. The background probe allows up to 200000 for that start, then adds 90 seconds for the blob call. |
| `S3RCH_LOGIN_PROVIDERS` | no | SIWE, plus one provider id `panopticon` built from `S3RCH_OAUTH_*` when the issuer is set | no | JSON array that replaces the default provider list. Include the SIWE entry. |
| `S3RCH_LOGIN_PROVIDER_ISSUER_MOVE` | no | unset | no | `<provider id>:<issuer>` pairs, comma-separated, approving a pinned issuer move. Remove it after the next successful login. |
| `S3RCH_OAUTH_CLIENT_ID` | no | `s3rch-web` | no | Client id for the single default OIDC provider. Public PKCE. No client secret. |
| `S3RCH_OAUTH_ISSUER` | no | unset | no | Issuer for that default provider. Unset, and with `S3RCH_LOGIN_PROVIDERS` unset, means SIWE only. |
| `S3RCH_OAUTH_WALLET_URL` | no | unset | no | Optional HTTPS URL the default provider calls to read a bound wallet. The access token is dropped after that read. |
| `S3RCH_PANOPTICON_TENANT_ID` | prod Deploy only | unset | no | GitHub variable. Not read by the server. Prod Deploy requires a UUID and writes it to App Service `PANOPTICON_TENANT_ID`. Unset or non-UUID fails the job and does not clear the live setting. |
| `S3RCH_TURN_CREDENTIAL` | only with the insecure flag | unset | yes | Fixed TURN credential sent to every signed-in browser when the insecure flag is on. |
| `S3RCH_TURN_INSECURE_STATIC_CREDENTIAL` | no | off | no | `1`, `true`, or `yes` sends `S3RCH_TURN_USERNAME` and `S3RCH_TURN_CREDENTIAL` instead of a minted REST credential. Leave it off. |
| `S3RCH_TURN_SECRET` | when a `turn:` or `turns:` URL is listed | unset | yes | Shared secret for TURN REST credentials. Same value as coturn `static-auth-secret`. Never `NEXT_PUBLIC_*`. |
| `S3RCH_TURN_TTL_SEC` | no | `3600` | no | REST credential lifetime in seconds. Integers from 60 through 86400 are used. Anything else stays 3600. |
| `S3RCH_TURN_URLS` | no | unset | no | Comma-separated `stun:`, `turn:`, and `turns:` URLs. Loopback and private addresses are dropped. |
| `S3RCH_TURN_USERNAME` | only with the insecure flag | unset | yes | Fixed TURN username paired with `S3RCH_TURN_CREDENTIAL`. |

`S3RCH_IDENTITY_STORAGE_ROOT` is not read. A user-assigned Azure identity also needs `AZURE_CLIENT_ID` (the client id, not a secret). The Azure SDK reads that name; this table does not, and the checker does not scan it.
