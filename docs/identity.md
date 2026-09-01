# s3r.ch user identity (2026-09-01)

Source of truth for login on this Next app. Product decisions agreed with Chris Hamilton (cchamilt).

This kit is **s3r.ch login** and, later, a Hypermesh **wallet door**. The Hypermesh portal stays Keycloak. Do not bolt OIDC onto s3r.ch as primary login.

Components here are written so they can be extracted into a shared kit later. The first implementation lives in this repo.

## What this slice ships

- EIP-4361 **Sign-In with Ethereum** (SIWE).
- Signed **HttpOnly cookie session** bound to a **checksummed** Ethereum address (never ENS, never email).
- Quiet connect / sign-in / sign-out on `/feed` (injected wallet only).
- Stubs for Gun SEA pair create and WebAuthn PRF wrap (no UI).

## What this slice does not ship

- Passkey UI, PRF implementation, or paper backup UI.
- ERC-1271 / smart accounts (needs an RPC we do not pin; EOA `verifyMessage` only).
- WalletConnect (needs `NEXT_PUBLIC_WC_PROJECT_ID` we do not have).
- ENS reverse lookup, Farcaster SIWF, or other public indicators as login.
- SociACL Check / certify. Do not import `FyberLabs/SociACL`.
- NextAuth, Keycloak, or email magic link on this app.
- Writing SIWE signatures or SEA private keys onto the public Gun graph.
- Changing seed Gun, Cloudflare, or `lib/auth.ts` seed helper (that file is `SEED_SECRET` only).

## Locks

| Lock | Why |
| --- | --- |
| Session key is the checksummed address | ENS and email are indicators, not the session subject |
| Mesh identity is a **local Gun SEA P-256 pair**, not the Ethereum key | Different curves. Ethereum secp256k1 signs SIWE; SEA is for later mesh crypto |
| Never call `user.recall({ sessionStorage: true })` | Gun would store the plaintext SEA pair |
| Never put SIWE signatures or SEA `priv` / `epriv` on the public Gun graph | Those are session / device secrets |
| Nonce lives in a **signed cookie**, not an in-memory `Map` | Azure App Service is multi-instance; Redis is not in this slice |
| OIDC is not primary login | Hypermesh portal can stay Keycloak; this kit is wallet login |
| Passkey WebAuthn PRF wrap is recovery | Tested after SIWE works. This PR stubs types only |
| `lib/auth.ts` is seed authorize | User identity lives in `lib/identity/` |

## Libraries

Pinned to current majors compatible with Next.js 16, React 19, and Node 24:

| Package | Role |
| --- | --- |
| `siwe` | Construct and parse EIP-4361 messages |
| `viem` | EOA `verifyMessage` / recover. Checksum via `getAddress` |
| `wagmi` v3 | Injected connector only. No RainbowKit, no ConnectKit |
| `@tanstack/react-query` | Required by wagmi |
| `jose` | Sign nonce and session cookies (HS256) |
| `gun` / `gun/sea` | Already a dependency. `createSeaPair()` may call `SEA.pair()`. Not wired to the UI |

No SimpleWebAuthn in this slice.

WalletConnect is a documented follow-up. Do not add a WalletConnect project id to CI or the Dockerfile.

## Module map

| Path | Job |
| --- | --- |
| `lib/identity/config.ts` | TTLs, statement, allowed SIWE hostnames, cookie name prefixes |
| `lib/identity/secret.ts` | `IDENTITY_SESSION_SECRET` (min 32 chars). Local fallback only when unset and not production |
| `lib/identity/cookies.ts` | `__Host-` on HTTPS, `Host-` on HTTP localhost. HttpOnly, SameSite=Lax, `Path=/` |
| `lib/identity/nonce.ts` | Random SIWE nonce + signed cookie payload |
| `lib/identity/session.ts` | Signed session `{ address, chainId, iat, exp }` |
| `lib/identity/siwe.ts` | Parse, domain/nonce/expiry checks, viem signature verify |
| `lib/identity/wrap.ts` | PRF envelope types + `notImplemented()` |
| `lib/identity/sea.ts` | `createSeaPair()` stub. Does not persist keys |
| `lib/identity/wagmi.ts` | Injected-only wagmi config |
| `app/api/identity/nonce` | `GET` — issue nonce cookie, return `{ nonce }` |
| `app/api/identity/verify` | `POST` `{ message, signature }` — verify SIWE, set session |
| `app/api/identity/session` | `GET` — current `{ address, chainId }` or 401 |
| `app/api/identity/logout` | `POST` — clear identity cookies |
| `components/IdentityBar.tsx` | Quiet `/feed` connect + SIWE + sign out |

## Cookies

App Service has more than one instance. The nonce **must** be in a signed cookie, not process memory.

| Cookie | Prefix | Payload |
| --- | --- | --- |
| `s3rch-nonce` | `__Host-` on HTTPS, `Host-` on HTTP | jose JWT `{ nonce, iat, exp }` — a few minutes |
| `s3rch-session` | same | jose JWT `{ address, chainId, iat, exp }` |

`__Host-` requires `Secure`, `Path=/`, and no `Domain` attribute. That is the strongest prefix that works on `https://s3r.ch`. It does not set on `http://localhost`, so local HTTP uses `Host-s3rch-*` with `Secure` off. Readers accept either name.

Flags: HttpOnly, SameSite=Lax, Path=/, Secure on HTTPS.

## `IDENTITY_SESSION_SECRET`

HMAC key for both cookies. **Minimum 32 characters.**

- **Production:** if missing or too short, `POST /api/identity/verify` (and the other identity routes that sign/read cookies) return **500** and log a clear error. Auth is not silently disabled.
- **Non-production:** if the env var is unset, a documented local fallback is used so `next dev` works. Do not use that fallback in production.

Operator step (not in this PR): set `IDENTITY_SESSION_SECRET` on the Azure App Service (Key Vault later). Build and CI must not require it.

## SIWE verify rules

Client builds EIP-4361 with:

- `domain` = `window.location.host`
- `uri` = `window.location.origin`
- `chainId` from the wallet
- `nonce` from `GET /api/identity/nonce`
- `statement` = `Sign in to s3r.ch`

Server:

1. Parse with `siwe`.
2. Domain hostname must be `s3r.ch` or `localhost` (port allowed). Reject anything else, including lookalikes.
3. Message `domain` must match the request `Host` / `X-Forwarded-Host`.
4. Nonce must match the signed nonce cookie.
5. Honour `expirationTime` / `notBefore` when present.
6. Verify the signature with viem (`verifyMessage`) for an EOA. Recovered address is checksummed and becomes the session subject.

Reject on domain mismatch. Do not treat ENS names as the session key.

## Recovery stub (not UI)

`lib/identity/wrap.ts` describes a later envelope:

- WebAuthn **PRF** derives a KEK.
- A data-encryption key (DEK) is wrapped by that PRF KEK **and** a second KEK.
- Store the envelope in **IndexedDB**.
- `rp.id` = `s3r.ch`.
- Never put the envelope or keys on a public Gun node.

`notImplemented()` throws. No passkey button ships here.

## SEA stub

`createSeaPair()` may call `gun/sea` `SEA.pair()`. That pair is **local mesh identity**, not the SIWE wallet. Do not persist `priv` / `epriv`. Do not `recall()` into `sessionStorage`. The UI does not call this yet.

## Follow-ups

- WalletConnect injected-or-QR, gated on `NEXT_PUBLIC_WC_PROJECT_ID`.
- ERC-1271 / EIP-6492 via a pinned RPC.
- WebAuthn PRF wrap implementation + UI (after SIWE is proven).
- Public indicators (ENS reverse, Farcaster) **after** auth, as held claims.
- SociACL Check when sharing needs grants (adapter lives outside this repo).
- Azure Key Vault for `IDENTITY_SESSION_SECRET`.
