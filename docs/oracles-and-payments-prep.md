# Oracles attest + payments consume

Ops + smoke note. Not visitor UI. Not a live feed paywall.

Panopticon oracles attest v0 and payments access v0 consume are TURN twins: SIWE stays on s3r.ch; the Next server hops with the product API key. No Stripe. No wallet door.

## Env (server-only)

TURN already ships `PANOPTICON_TURN_BASE` + shared tenant/key. There is no generic `PANOPTICON_BASE`. Dedicated product bases:

| Env | Role |
| --- | --- |
| `PANOPTICON_ORACLES_BASE` | Attest origin, or origin plus `/api/v1` / `/api/v1/oracles` / `/api/v1/oracles/v0`. Empty = no hop. Lab: `https://api.test.hyperme.sh`. |
| `PANOPTICON_PAYMENTS_BASE` | Intent/receipt origin, or origin plus `/api/v1` / `/api/v1/payments` / `/api/v1/payments/v0`. Empty = no hop. Lab: `https://api.test.hyperme.sh`. |
| `PANOPTICON_TENANT_ID` | Shared with TURN. Marketplace tenant UUID (`X-Tenant-ID`). |
| `PANOPTICON_API_KEY` | Shared with TURN. Product API key (`X-Api-Key`, purpose=service). Hold in Key Vault. Never `NEXT_PUBLIC_*`. |

Empty any of the three settings for a hop (the default) is **fail-soft**:

- Keep today’s browser-first SIWE ecrecover, ERC-1271, ENS reverse+forward.
- Do not hard-fail `/feed`. Do not hard-paywall a page or connection.
- Do not invent a SociACL grant from a missing `digest` or receipt.
- Do not invent credentials.

Never put tenant or API key in `NEXT_PUBLIC_*`, Gun, `localStorage`, or the browser.

## Oracles hop

SIWE stays on the s3r.ch origin. `POST /api/oracles/attest` is session-gated like `/api/turn/allocate`. Next hops `POST /api/v1/oracles/v0/attest` with `X-Tenant-ID` + `X-Api-Key`. Hop `clientHint` is locked to `s3rch-next`. `/verify` later. No UI paywall.

| Outcome | Next status | Body |
| --- | --- | --- |
| Unsigned / bad session | 401 | `{ error: "unauthorized" }` |
| Empty / invalid env | 503 | `{ error: "oracles-unconfigured" }` |
| Plane 401 / 503 / network / bad JSON | 503 | `{ error: "oracles-unavailable" }` |
| Invalid `kind` / `subject` | 400 | `{ error: "invalid-subject" }` |
| Plane HTTP 200 (`ok: true` or fail-soft `ok: false`) | 200 | `{ ok, kind, subject, status, observedAt, digest?, upstream }` |

Plane fail-soft statuses (`not_found` \| `unreachable` \| `error`) stay HTTP 200 + `ok: false`. That is not a grant. Do not persist `null` as proof.

### Oracles smoke

Signed-in (cookie session), env set to lab (`PANOPTICON_ORACLES_BASE=https://api.test.hyperme.sh` plus the shared tenant/key):

```http
POST /api/oracles/attest
Content-Type: application/json

{"kind":"public_attestation","subject":"eas:uid:0xatteststub"}
```

→ Next hops `POST https://api.test.hyperme.sh/api/v1/oracles/v0/attest` with `clientHint: "s3rch-next"` → plane JSON (`observed` or `ok: false` / `not_found` if the lab mock map is empty). `digest` is optional.

Unsigned:

```http
POST /api/oracles/attest
```

→ `401 { "error": "unauthorized" }`.

Empty env (default App Settings):

```http
POST /api/oracles/attest
```

with a valid session → `503 { "error": "oracles-unconfigured" }`. No invented key. `/feed` unchanged.

## Payments hop

SIWE stays on the s3r.ch origin. Signed-in `POST /api/payments/receipt` and optional `POST /api/payments/intent` hop with the product API key (`purpose=service`). Not SIWE-as-Panopticon-login. Not Keycloak as s3r.ch login. Wallet door parked. Not Stripe / `core/payment-service`.

| Product | Plane URI | Next route | Notes |
| --- | --- | --- | --- |
| Payments receipt | `POST /api/v1/payments/v0/receipt` | `POST /api/payments/receipt` | Required plane hop. Pass through HTTP 200 including `ok: false`. |
| Payments intent | `POST /api/v1/payments/v0/intent` | `POST /api/payments/intent` | Optional quote. A client that already knows pay-to can skip this. |

Fail-soft plane statuses (HTTP 200, `ok: false`): `not_found` \| `unverified` \| `expired` \| `unavailable` \| `error`.

| Outcome | Next status | Body |
| --- | --- | --- |
| Unsigned / bad session | 401 | `{ error: "unauthorized" }` |
| Empty / invalid env | 503 | `{ error: "payments-unconfigured" }` |
| Plane 401 / 503 / network / bad JSON | 503 | `{ error: "payments-unavailable" }` |
| Invalid `resource` / `txRef` / amount | 400 | `{ error: "invalid-resource" }` (or `invalid-tx-ref` / `invalid-amount`) |
| Plane HTTP 200 (`ok: true` or fail-soft `ok: false`) | 200 | receipt `{ ok, status, resource, accessUntil, upstream }` or intent quote JSON |

### Payments smoke

- **Signed-in hop → plane.** Cookie SIWE session + `PANOPTICON_PAYMENTS_BASE=https://api.test.hyperme.sh` + tenant + key. Next `POST /api/payments/receipt` `{ resource, txRef }` hops `POST https://api.test.hyperme.sh/api/v1/payments/v0/receipt` with `X-Tenant-ID` + `X-Api-Key`. Plane JSON (`ok` / `status` / `accessUntil`) is the 200 body. Optional intent is the same habit on `/api/payments/intent`.
- **Unauth 401.** No session cookie → `{ error: "unauthorized" }`. Product API key is never sent from the browser.
- **Empty env fail-soft.** Missing `PANOPTICON_PAYMENTS_BASE` / tenant / key → `503 { error: "payments-unconfigured" }`. Network / plane 401 / 503 / bad JSON → `503 { error: "payments-unavailable" }`. Keep `/feed` usable. Do not invent a SociACL grant from `accessUntil: null`.

## Integrator contracts

In-repo on FyberLabs/panopticon (do not copy onto s3r.ch pages):

- [`products/oracles/docs/oracles-attest-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/oracles/docs/oracles-attest-v0.md)
- [`products/payments/docs/payments-access-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/payments/docs/payments-access-v0.md)

TURN consume (already live, unchanged): [`products/turn/docs/turn-allocate-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/turn/docs/turn-allocate-v0.md).

## Operator / infra habit

Same as TURN / `IDENTITY_SESSION_SECRET` / `SEED_SECRET`: App Service application settings, Key Vault (`kv-fyber-cg47`) for `PANOPTICON_API_KEY`, Terraform in **FyberLabs/infra** `terraform/s3rch`. **Research owns that layer** (`PANOPTICON_ORACLES_BASE` and `PANOPTICON_PAYMENTS_BASE` App Settings, TURN twin). This repo is s3r.ch consume only — it does not wire ACA and does not add Terraform here.

Empty oracles or payments env stays fail-soft.
