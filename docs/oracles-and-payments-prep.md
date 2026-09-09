# Oracles / payments env prep

Ops note only. Not visitor UI. Not a live hop.

Panopticon planes already exist (oracles attest v0, payments access v0). s3r.ch consume is **held** until Product asks. This slice names the App Service settings and the fail-soft rule so a later hop can reuse the TURN habit.

## Env (server-only)

TURN already ships `PANOPTICON_TURN_BASE` + shared tenant/key. There is no generic `PANOPTICON_BASE`. Dedicated product bases:

| Env | Role |
| --- | --- |
| `PANOPTICON_ORACLES_BASE` | Later attest origin, or origin plus `/api/v1` / `/api/v1/oracles`. Empty = no hop. |
| `PANOPTICON_PAYMENTS_BASE` | Later intent/receipt origin, or origin plus `/api/v1` / `/api/v1/payments`. Empty = no hop. |
| `PANOPTICON_TENANT_ID` | Shared with TURN. Marketplace tenant UUID (`X-Tenant-ID`). |
| `PANOPTICON_API_KEY` | Shared with TURN. Product API key (`X-Api-Key`). Hold in Key Vault. Never `NEXT_PUBLIC_*`. |

Empty any of these (the default) is **fail-soft**:

- Keep today’s browser-first SIWE ecrecover, ERC-1271, ENS reverse+forward.
- Do not hard-fail `/feed`. Do not hard-paywall a page or connection.
- Do not invent a SociACL grant from a missing `digest` or receipt.
- Do not call Panopticon from this repo until consume is unlocked.

Never put tenant or API key in `NEXT_PUBLIC_*`, Gun, `localStorage`, or the browser.

## Later hops (held)

SIWE stays on the s3r.ch origin. A later Next server hop would use the product API key. Not this PR. No `app/api/oracles/*`, no payments route, no UI paywall.

| Product | Held URI | Notes |
| --- | --- | --- |
| Oracles | `POST /api/v1/oracles/v0/attest` | `/verify` later. Fail-soft hop outcomes: `not_found` \| `unreachable` \| `error` \| `ok: false`. |
| Payments | `POST /api/v1/payments/v0/receipt` | Required plane hop when unlocked. Optional `POST /api/v1/payments/v0/intent`. Fail-soft: `not_found` \| `unverified` \| `expired` \| `unavailable` \| `error` \| `ok: false`. |

## Integrator contracts

In-repo on FyberLabs/panopticon (do not copy onto s3r.ch pages):

- [`products/oracles/docs/oracles-attest-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/oracles/docs/oracles-attest-v0.md)
- [`products/payments/docs/payments-access-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/payments/docs/payments-access-v0.md)

TURN consume (already live, unchanged): [`products/turn/docs/turn-allocate-v0.md`](https://github.com/FyberLabs/panopticon/blob/main/products/turn/docs/turn-allocate-v0.md).

## Operator / infra habit

Same as TURN / `IDENTITY_SESSION_SECRET` / `SEED_SECRET`: App Service application settings, Key Vault (`kv-fyber-cg47`) for `PANOPTICON_API_KEY`, Terraform in **FyberLabs/infra** `terraform/s3rch`. **Research owns that layer.** This PR does not wire ACA, does not add Terraform here, and does not call Panopticon.

Leave the new bases empty until consume is asked for. Empty env stays fail-soft.
