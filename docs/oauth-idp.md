# s3r.ch OAuth IdP (backup)

Status: plan. 2026-09-26.
Wallet / SIWE stays **primary**. OAuth through Panopticon Keycloak is **backup**.
Parent: [identity.md](identity.md). Hypermesh plane: [auth-kit](https://github.com/FyberLabs/hypermesh-docs/blob/main/auth-kit.md), [customer-interfaces](https://github.com/FyberLabs/hypermesh-docs/blob/main/customer-interfaces.md). Brokers: [panopticon Keycloak README](https://github.com/FyberLabs/panopticon/blob/main/infra/keycloak/README.md).

## Lock

| Rule | Meaning |
| --- | --- |
| Wallet first | Default CTA is connect wallet → SIWE. Session subject for Gun, Check, and AI forum owner is the checksummed address (after link). |
| OAuth backup | Panopticon Keycloak OIDC is allowed when the renter cannot SIWE yet, or prefers the same Microsoft / GitHub / Google account used on Hypermesh. |
| Same IdP plane | No second IdP stack on s3r.ch Azure. Same `controlplane` realm as Hypermesh portal / CLI / visor. |
| Same brokers | `microsoft` (Entra), `github`, `google`. Reuse Keycloak’s existing apps. Do not register s3r.ch-only OAuth apps that skip Keycloak. |
| No Keycloak `sub` as Gun owner | Persist `sub` ↔ address. Forum channel stays `s3rch:forum:<address>`. |
| No email-as-IdP | Magic link, Privy, Dynamic, Web3Auth, CDP embedded email stay out. Smart Wallet remains an onramp to an address, then SIWE. |

This replaces “s3r.ch does not use Keycloak as an IdP” for the backup door only. Keycloak is not the primary login CTA.

## Brokers (shared with Hypermesh)

| Alias | Provider |
| --- | --- |
| `microsoft` | Microsoft Entra OIDC |
| `github` | GitHub |
| `google` | Google |

Broker callbacks stay on the Keycloak host. s3r.ch is a Keycloak **client** with its own redirect URI.

## Slices (not coded)

1. Keycloak client for s3r.ch origins (test + prod).
2. Start + callback routes; backup session; tokens never on Gun.
3. One SIWE to link `sub` ↔ address; unlinked OAuth stays limited.
4. UI: primary wallet / SIWE; secondary Continue with Microsoft / GitHub / Google (or Hypermesh account).

## Renter how-to

Product how-tos live with the Hypermesh project notes (account setup + AI forum). This file is the identity lock for implementers.
