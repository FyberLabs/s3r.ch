# Oracles attest consume / payments env prep

Ops + smoke note. Not visitor UI.

Panopticon oracles attest v0 consume is the TURN twin: SIWE stays on s3r.ch; the Next server hops with the product API key. Payments access v0 stays **held**.

## Env (server-only)

TURN already ships `PANOPTICON_TURN_BASE` + shared tenant/key. There is no generic `PANOPTICON_BASE`. Dedicated product bases:

| Env | Role |
| --- | --- |
| `PANOPTICON_ORACLES_BASE` | Attest origin, or origin plus `/api/v1` / `/api/v1/oracles` / `/api/v1/oracles/v0`. Empty = no hop. Lab: `https://api.test.hyperme.sh`. |
| `PANOPTICON_PAYMENTS_BASE` | Later intent/receipt origin, or origin plus `/api/v1` / `/api/v1/payments`. Empty = no hop. **Held.** |
| `PANOPTICON_TENANT_ID` | Shared with TURN. Marketplace tenant UUID (`X-Tenant-ID`). |
| `PANOPTICON_API_KEY` | Shared with TURN. Product API key (`X-Api-Key`, purpose=service). Hold in Key Vault. Never `NEXT_PUBLIC_*`. |

Empty any of the three attest settings (the default) is **fail-soft**:

- Keep today’s browser-first SIWE ecrecover, ERC-1271, ENS reverse+forward.
- Do not hard-fail `/feed`. Do not hard-paywall a page or connection.
- Do not invent a SociACL grant from a missing `digest` or receipt.
- Do not invent credentials.

Never put tenant or API key in `NEXT_PUBLIC_*`, Gun, `localStorage`, or the browser.

## Oracles hop (this slice)

SIWE stays on the s3r.ch origin. `POST /api/oracles/attest` is session-gated like `/api/turn/allocate`. Next hops `POST /api/v1/oracles/v0/attest` with `X-Tenant-ID` + `X-Api-Key`. `/verify` later. No payments route. No UI paywall.

| Outcome | Next status | Body |
| --- | --- | --- |
| Unsigned / bad session | 401 | `{ error: "unauthorized" }` |
| Empty / invalid env | 503 | `{ error: "oracles-unconfigured" }` |
| Plane 401 / 503 / network / bad JSON | 503 | `{ error: "oracles-unavailable" }` |
| Invalid `kind` / `subject` | 400 | `{ error: "invalid-subject" }` |
| Plane HTTP 200 (`ok: true` or fail-soft `ok: false`) | 200 | `{ ok, kind, subject, status, observedAt, digest, upstream }` |

Plane fail-soft statuses (`not_found` \| `unreachable` \| `error`) stay HTTP 200 + `ok: false`. That is not a grant. Do not persist `null` as proof.

### Smoke

Signed-in (cookie session), env set to lab (`PANOPTICON_ORACLES_BASE=https://api.test.hyperme.sh` plus the shared tenant/key):

```http
POST /api/oracles/attest
Content-Type: application/json

{"kind":"public_attestation","subject":"eas:uid:0xatteststub"}
```

→ Next hops `POST https://api.test.hyperme.sh/api/v1/oracles/v0/attest` → plane JSON (`observed` or `ok: false` / `not_found` if the lab mock map is empty).

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

## Payments (held)

| Product | Held URI | Notes |
| --- | --- | --- |
| Payments | `POST /api/v1/payments/v0/receipt` | Required plane hop when unlocked. Optional `POST /api/v1/payments/v0/intent`. Fail-soft: `not_found` \| `unverified` \| `expired` \| `unavailable` \| `error` \| `ok: false`. |

No `app/api/payments/*`.

## Integrator contracts

In-repo on FyberLabs/panopticon (do not copy onto s3r.ch pages):

- [`products/oracles/docs/oracles-attest-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/oracles/docs/oracles-attest-v0.md)
- [`products/payments/docs/payments-access-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/payments/docs/payments-access-v0.md)

TURN consume (already live, unchanged): [`products/turn/docs/turn-allocate-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/turn/docs/turn-allocate-v0.md).

## Operator / infra habit

Same as TURN / `IDENTITY_SESSION_SECRET` / `SEED_SECRET`: App Service application settings, Key Vault (`kv-fyber-cg47`) for `PANOPTICON_API_KEY`, Terraform in **FyberLabs/infra** `terraform/s3rch`. **Research owns that layer** (`PANOPTICON_ORACLES_BASE` App Setting, TURN twin). This PR does not wire ACA and does not add Terraform here.

Leave `PANOPTICON_PAYMENTS_BASE` empty until Product asks. Empty payments env stays fail-soft.
