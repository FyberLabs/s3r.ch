# s3r.ch OAuth IdP (backup)

Status: start, callback, secondary Continue, and two-way SIWE link ship. 2026-09-26.
Wallet / SIWE stays **primary**. OAuth through Panopticon Keycloak is **backup**.
Parent: [identity.md](identity.md). Hypermesh plane: [auth-kit](https://github.com/FyberLabs/hypermesh-docs/blob/main/auth-kit.md), [customer-interfaces](https://github.com/FyberLabs/hypermesh-docs/blob/main/customer-interfaces.md). Brokers: [panopticon Keycloak README](https://github.com/FyberLabs/panopticon/blob/main/infra/keycloak/README.md).

## Decision

| Rule | Meaning |
| --- | --- |
| Wallet first | Default CTA is connect wallet → SIWE. Gun and Check object owner, and the AI forum actor, are the sociacl checksummed address after link. The Gun mesh key stays on the wallet that signed. |
| OAuth backup | Panopticon Keycloak OIDC is allowed when the renter cannot SIWE yet, or prefers the same Microsoft / GitHub / Google account used on Hypermesh. |
| Same IdP plane | No second IdP stack on s3r.ch Azure. Same `controlplane` realm as Hypermesh portal / CLI / visor. |
| Same brokers | `microsoft` (Entra), `github`, `google`. Reuse Keycloak’s existing apps. Do not register s3r.ch-only OAuth apps that skip Keycloak. |
| No Keycloak `sub` as Gun owner | Wallet and Keycloak `sub` are handles on one sociacl owner (the checksummed address). Forum channel stays `s3rch:forum:<address>`. |
| No email-as-IdP | Magic link, Privy, Dynamic, Web3Auth, CDP embedded email stay out. Smart Wallet remains an onramp to an address, then SIWE. |
| hyperme.sh wallet handoff | When `GET /auth/siwe/me` returns a bound address, ask to connect that wallet. Yes is SIWE for that address, then the existing link. No leaves OAuth-only. No bound wallet keeps create-or-connect. Do not mint a key. |

This replaces “s3r.ch does not use Keycloak as an IdP” for the backup door only. Keycloak is not the primary login CTA.

## Brokers (shared with Hypermesh)

| Alias | Provider |
| --- | --- |
| `microsoft` | Microsoft Entra OIDC |
| `github` | GitHub |
| `google` | Google |

Broker callbacks stay on the Keycloak host. s3r.ch is a Keycloak **client** with its own redirect URI.

## Slices

1. Keycloak client `s3rch-web` on `controlplane` (Panopticon realm import + live upsert). Public PKCE. Exact callback URIs. No new brokers.
2. Start + callback routes; backup session cookie; tokens never stored and never on Gun. Missing issuer fails closed.
3. Two-way link. OAuth then SIWE, or SIWE then OAuth, writes both handles onto one sociacl owner in the identity document (development default `data/identity-links.json`; production is one private Azure Blob). The first linked wallet is the owner. A later wallet is another handle. Two existing owners do not merge (`already-linked`). Unlinked OAuth is not an owner. The document is not Gun and stores no provider tokens. An unavailable identity store refuses linking; in production it also refuses wallet owner resolution. Startup checks the blob. See [identity-storage.md](identity-storage.md).
4. UI: primary Connect wallet / Sign in with wallet. Secondary Continue with Microsoft / GitHub / Google, or Hypermesh account, hitting the start route. Callback reads Panopticon `GET /auth/siwe/me` with the access token, then drops the token. A bound address is the hyperme.sh wallet handoff. Yes connects it by SIWE. No does not.

## Renter how-to

Product how-tos live with the Hypermesh project notes (account setup + AI forum). This file is the identity design for implementers.
