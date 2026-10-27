# Panopticon install

Panopticon is one optional login provider and one optional integration source on top of the [minimal install](install-minimal.md). SIWE stays available. Clearing the Panopticon settings returns the site to that minimal deployment. Gun data, the identity document, and browser SEA keys stay where they were.

This guide uses public placeholder hosts (`auth.example.org`, `api.example.org`). It does not contain a tenant id. Login details that are not install steps stay in [identity.md](identity.md) and [oauth-idp.md](oauth-idp.md). Oracles and payments smoke stays in [oracles-and-payments-prep.md](oracles-and-payments-prep.md).

## Login handler

Two ways to add the provider. Both are public PKCE. There is no client secret. Tokens are not stored and are not written to Gun.

### Single provider

Leave `S3RCH_LOGIN_PROVIDERS` unset and set:

| Name | Required | Default | Secret |
| --- | --- | --- | --- |
| `S3RCH_OAUTH_ISSUER` | yes, for this door | unset means the list is SIWE only | no |
| `S3RCH_OAUTH_CLIENT_ID` | no | `s3rch-web` | no |
| `S3RCH_OAUTH_WALLET_URL` | no | unset | no |

The provider id is `panopticon`. The label is `Panopticon`. The issuer is the realm URL, for example `https://auth.example.org/realms/controlplane`. A trailing slash on this single-provider issuer is stripped. `https` is required, except `http` on `localhost` or `127.0.0.1`.

`S3RCH_OAUTH_WALLET_URL` is an optional HTTPS URL the callback calls with the access token (`Authorization: Bearer`). The JSON it expects is `{ "bound": true, "wallet_address": "0x…" }`. A miss, or an unset URL, continues without a bound wallet. The token is dropped after that read.

Register this client's redirect URIs on the IdP. This app accepts only:

- `http://localhost:3000/api/identity/oauth/callback`
- `http://127.0.0.1:3000/api/identity/oauth/callback`
- `https://s3r.ch/api/identity/oauth/callback`
- `https://www.s3r.ch/api/identity/oauth/callback`

Local OIDC uses `npm run dev` on port 3000. Start is `GET /api/identity/oauth/start` (or `?provider=panopticon`).

### Several providers

`S3RCH_LOGIN_PROVIDERS` replaces the single-provider default. It is a JSON array and the whole list. Keep the SIWE entry. The Panopticon entry uses id `panopticon` so existing account keys remain the bare subject. Add at least one other OIDC provider the same way.

```json
[
  { "id": "siwe", "kind": "siwe", "label": "Wallet" },
  {
    "id": "panopticon",
    "kind": "oidc",
    "label": "Panopticon",
    "issuer": "https://auth.example.org/realms/controlplane",
    "clientId": "s3rch-web",
    "walletLookupUrl": "https://api.example.org/auth/siwe/me"
  },
  {
    "id": "directory",
    "kind": "oidc",
    "label": "Directory",
    "issuer": "https://idp.example.org/realms/apps",
    "clientId": "s3rch-web"
  }
]
```

`issuer` in this array is compared exactly, including a trailing slash. Endpoints default to `/protocol/openid-connect/{auth,token,certs}` under the issuer. Set `authorizationEndpoint`, `tokenEndpoint`, and `jwksUri` when the IdP uses other paths. `GET /api/identity/providers` returns ids and labels only.

### Account keys

`providerSubject` in `lib/identity/providers.ts`:

- Id `panopticon`, subject with no `:`, no whitespace, not an Ethereum address, length at most 256: the account key is the subject unchanged. A Keycloak UUID stays a bare UUID.
- Any other id, including `directory` above: `<id>:<encodeURIComponent(subject)>`.
- Longer than 256 characters after encoding: `<id>:%h` plus base64url SHA-256 of the subject.

An issuer move does not change the account key. The pin is `providerIssuers[<id>]`, a different field.

## Issuer pinning

The first successful login with a provider writes `providerIssuers[<id>]` to the identity document and logs:

```text
s3r.ch: login provider "panopticon" issuer pinned to https://auth.example.org/realms/controlplane.
```

A later login whose configured issuer differs is refused. The log line is:

```text
s3r.ch: login provider "panopticon" refused: configured issuer https://auth.example.org/realms/next differs from pinned https://auth.example.org/realms/controlplane. Set S3RCH_LOGIN_PROVIDER_ISSUER_MOVE=panopticon:https://auth.example.org/realms/next to approve the move.
```

The browser does not get a session for that provider. SIWE and any other provider whose pin still matches keep working.

To approve the move, set the variable to the provider id, a colon, and the new issuer. Several pairs are comma-separated. The issuer must be exactly the issuer configured for that id.

```text
S3RCH_LOGIN_PROVIDER_ISSUER_MOVE=panopticon:https://auth.example.org/realms/next,directory:https://idp.example.org/realms/apps
```

Restart so the process sees it. The next successful login for that provider updates the pin and logs:

```text
s3r.ch: login provider "panopticon" issuer moved from https://auth.example.org/realms/controlplane to https://auth.example.org/realms/next (approved by S3RCH_LOGIN_PROVIDER_ISSUER_MOVE).
```

Remove `S3RCH_LOGIN_PROVIDER_ISSUER_MOVE` after that login. Leaving it set keeps approving that exact issuer. Account keys on `people[].handles` stay the same strings. Only `providerIssuers.panopticon` changes.

## Integrations

These hops are optional and independent of the login handler. A site can use Panopticon OIDC with none of them, or the hops with SIWE only. None of them write the identity document or the Gun seed.

Each hop needs all three of `PANOPTICON_TENANT_ID`, `PANOPTICON_API_KEY`, and that hop's base URL. `PANOPTICON_TENANT_ID` is the marketplace tenant UUID sent as `X-Tenant-ID`. It is an identifier. `PANOPTICON_API_KEY` is `X-Api-Key` and a secret. Missing any one of the three leaves that hop unconfigured.

| Name | Unset |
| --- | --- |
| `PANOPTICON_TURN_BASE` | Panopticon TURN allocate is skipped. `POST /api/turn/allocate` uses `S3RCH_TURN_*` from the [minimal guide](install-minimal.md#turn) when that relay is set, and otherwise returns 503 `turn-unconfigured`. Browsers stay on STUN and `/gun`. |
| `PANOPTICON_ORACLES_BASE` | `POST /api/oracles/attest` returns 503 `oracles-unconfigured`. |
| `PANOPTICON_PAYMENTS_BASE` | `POST /api/payments/receipt` and `POST /api/payments/intent` return 503 `payments-unconfigured`. |
| `PANOPTICON_TENANT_ID` or `PANOPTICON_API_KEY` | Every hop above is unconfigured, even if a base URL is set. OIDC login does not read these two. |

Bases are an origin, or an origin plus the path prefix the code already joins (`/api/v1`, and the product prefix). The app calls:

- `POST /api/v1/turn/allocate`
- `POST /api/v1/oracles/v0/attest`
- `POST /api/v1/payments/v0/receipt` and optional `POST /api/v1/payments/v0/intent`

A configured hop that does not answer is 503 `turn-unavailable`, `oracles-unavailable`, or `payments-unavailable`. TURN tries the static relay after a failed hop and can still return 200 from `S3RCH_TURN_*`. Health for the Panopticon turn service follows the hop: `configured` before any attempt, `ok` after a hop that returned ice servers, `unreachable` after a failed hop. `staticTurn` is separate and becomes `configured` when `S3RCH_TURN_URLS` is accepted.

`/api/health` reports the three services under `dependencies.panopticon.services`. After a successful signed-in call to each configured hop, those services are `ok` and the parent status is `configured`. A failed hop sets that service to `unreachable` and the parent to `degraded`. The HTTP status of `/api/health` stays 200.

Contract notes live in FyberLabs/panopticon (`products/turn/docs/turn-allocate-v0.md`, `products/oracles/docs/oracles-attest-v0.md`, `products/payments/docs/payments-access-v0.md`). This repo does not run coturn for the Panopticon hop. The minimal guide's coturn is the static fallback only.

## Deploy variable

For the repository deploy workflow (`.github/workflows/deploy.yml`), the tenant id is the GitHub variable `S3RCH_PANOPTICON_TENANT_ID` on the repository or on the `prod` environment. Deploy writes it to the App Service setting `PANOPTICON_TENANT_ID`. The workflow checks the variable with `scripts/require-panopticon-tenant-id.sh` before the image push.

- Set it when that deploy should publish the tenant id. The value is a UUID. A value that is not a UUID fails the job and does not write the setting.
- Unset, the script exits 0, the job continues, and the live App Service value is left as it is. The workflow does not clear it.
- The value is not a secret and must not be committed. The script masks it in Actions logs.

Issue [#103](https://github.com/FyberLabs/s3r.ch/issues/103) asks for a preflight that fails the job when the variable is missing, and for that requirement in the deploy docs. That change is not in this tree. The behavior above is what `deploy.yml` does today. `PANOPTICON_API_KEY` and the `PANOPTICON_*_BASE` hostnames are applied outside this repo's workflow; this repository only consumes them at runtime.

## Local and production

| | Local (`npm run dev`) | Production image and the deploy workflow |
| --- | --- | --- |
| Identity document | `data/identity-links.json` (or `S3RCH_IDENTITY_LINKS`) | Azure Blob `identity-links.json` via `S3RCH_IDENTITY_BLOB_ACCOUNT` and `S3RCH_IDENTITY_BLOB_CONTAINER` |
| `IDENTITY_SESSION_SECRET` | optional; unset uses the development fallback | required, 32 characters or more |
| `PANOPTICON_TENANT_ID` | set in `.env.local` when you want the hops | App Service setting written from `S3RCH_PANOPTICON_TENANT_ID` when that variable is set |
| `PANOPTICON_API_KEY` and base URLs | `.env.local`, server-side | runtime settings on the app, not Docker build-args |
| OIDC redirect | `http://localhost:3000` and `http://127.0.0.1:3000` | `https://s3r.ch` and `https://www.s3r.ch` |
| SIWE host | `localhost`, `127.0.0.1`, or `s3r.ch` | same allowlist |
| Confirm fixture code | `000000` unless `CONFIRM_FIXTURE=0` | off unless `CONFIRM_FIXTURE=1` |
| `NODE_ENV` | unset for `npm run dev` and for `npm start` unless you export it | `production` in the image |
| Gun files | `./data/radata` and `./data/snapshot.json` | `/app/data/…` in the image; ephemeral unless a volume is mounted |

`.env.local` is for the development process. `NEXT_PUBLIC_WC_PROJECT_ID` is the one value inlined at build time. Panopticon names are read at runtime.

## Secrets

`PANOPTICON_API_KEY`, `S3RCH_TURN_SECRET`, `IDENTITY_SESSION_SECRET`, and `SEED_SECRET` stay in a secret store and in the server environment. They are not `NEXT_PUBLIC_*`, not Gun, not the browser, and not git. `PANOPTICON_TENANT_ID` and `S3RCH_PANOPTICON_TENANT_ID` are identifiers; keep them out of git anyway. OIDC access tokens are used for the code exchange and the optional wallet lookup, then dropped.

## Storage, the public seed, and recovery

Panopticon does not hold this app's account links or the Gun SEA key.

- The identity document (file or blob) holds linked wallet addresses, OIDC subjects, age confirmations, and `providerIssuers`. Backup and restore are in the [minimal guide](install-minimal.md#backup-and-restore).
- The mesh identity is the SEA `pub` in origin IndexedDB. Passkey PRF wrap and the paper string recover that pair in the browser. Server disk and the Panopticon issuer do not store `priv` / `epriv`.
- `POST /api/seed` rebuilds seeder public items into Gun and `GUN_SNAPSHOT`. It does not restore account links, issuer pins, or SEA keys. `GUN_FILE` plus `GUN_SNAPSHOT` are the on-disk Gun copy.
- Removing Panopticon is unsetting `S3RCH_OAUTH_ISSUER` (or removing the `panopticon` entry from `S3RCH_LOGIN_PROVIDERS`) and unsetting `PANOPTICON_TENANT_ID`, `PANOPTICON_API_KEY`, and each `PANOPTICON_*_BASE`. Restart. SIWE still signs in. `/api/health` reports Panopticon as `not-configured`. Rows already in the identity document and in Gun remain. A `providerIssuers.panopticon` pin remains until you edit the document; it is unused while that provider is absent. Account keys do not change. Configuring the same issuer again uses the same pin and the same keys.

## Future: other organizations' login handlers

Panopticon is one OIDC provider id in `S3RCH_LOGIN_PROVIDERS`. Another organization adds its own entry (`directory` in the example, or any id matching `[a-z0-9][a-z0-9-]{0,31}` except `siwe`) with its issuer, client id, and endpoints. Subjects are namespaced by that id, so two issuers cannot share an account key. Issuer pins are per id. SIWE stays on the list. The Panopticon hops stay optional and are not required for that other provider to sign in. A shared Gun network is people running this app and peering browsers at `/gun` and WebRTC; the login handler does not have to be the same issuer on every node.
