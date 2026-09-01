# s3r.ch user identity (2026-09-01)

Source of truth for login on this Next app. Product decisions agreed with Chris Hamilton (cchamilt).

This kit is **s3r.ch login** and, later, a Hypermesh **wallet door**. The Hypermesh portal stays Keycloak. Do not bolt OIDC onto s3r.ch as primary login.

Components here are written so they can be extracted into a shared kit later. The first implementation lives in this repo.

## What this slice ships

- EIP-4361 **Sign-In with Ethereum** (SIWE).
- Signed **HttpOnly cookie session** bound to a **checksummed** Ethereum address (never ENS, never email, never a SEA pub).
- Quiet connect / sign-in / sign-out on `/feed` (injected wallet only).
- After the SIWE session is set: a **local Gun SEA P-256 pair** (different curve from Ethereum) plus a **wallet-signed link** (`pub` belongs to this checksummed address), persisted in **origin IndexedDB**.
- **WebAuthn PRF wrap** of that local pair (recovery / device proof, **not** login). Envelope version 1 in IndexedDB, with ≥2 KEKs (PRF + wallet-bound secondary). Quiet `/feed` controls: wrap / unlock / status.

## What this slice does not ship

- Passkey as primary login. Session subject stays the checksummed address.
- Writing the envelope, DEK, KEKs, SIWE signatures, or SEA `priv` / `epriv` to Gun for recovery.
- Paper-backup UI (the secondary slot accepts a paper string in code; lab UI uses the injected wallet).
- ERC-1271 / smart accounts (needs an RPC we do not pin; EOA `verifyMessage` only).
- WalletConnect (needs `NEXT_PUBLIC_WC_PROJECT_ID` we do not have).
- ENS reverse lookup, Farcaster SIWF, or other public indicators as login.
- SociACL Check / certify. Do not import `FyberLabs/SociACL`.
- NextAuth, Keycloak, or email magic link on this app.
- Changing seed Gun, Cloudflare, GitHub Actions, or `lib/auth.ts` seed helper (that file is `SEED_SECRET` only).

## Locks

| Lock | Why |
| --- | --- |
| Session key is the checksummed address | ENS and email are indicators, not the session subject |
| Mesh identity is a **local Gun SEA P-256 pair**, not the Ethereum key | Different curves. Ethereum secp256k1 signs SIWE; SEA is for later mesh crypto |
| Never call `user.recall({ sessionStorage: true })` | Gun would store the plaintext SEA pair. Never `sessionStorage` for this kit. |
| Never put SIWE signatures, SEA `priv` / `epriv`, the envelope, DEK, or KEKs on the public Gun graph | Those are session / device secrets. IndexedDB is origin-local only. |
| Nonce lives in a **signed cookie**, not an in-memory `Map` | Azure App Service is multi-instance; Redis is not in this slice |
| OIDC is not primary login | Hypermesh portal can stay Keycloak; this kit is wallet login |
| Passkey WebAuthn PRF wrap is recovery | PRF is device proof. It does not become the session subject |
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
| `gun` / `gun/sea` | Already a dependency. `createSeaPair()` calls `SEA.pair()` after SIWE. Persist in IndexedDB, not `recall()` |

No SimpleWebAuthn. The PRF helper uses native `navigator.credentials.create` / `get` with `extensions.prf`.

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
| `lib/identity/wrap.ts` | Envelope v1 + HKDF-then-AES-GCM wrap/unwrap of the SEA pair |
| `lib/identity/webauthn-prf.ts` | Native WebAuthn PRF create/get. Refuses to fake a wrap |
| `lib/identity/sea.ts` | `createSeaPair()` — local P-256 pair. Does not `recall()` |
| `lib/identity/mesh-link.ts` | Domain-bound statement: this SEA `pub` belongs to this address |
| `lib/identity/idb.ts` | Origin IndexedDB: plaintext **or** wrapped record. Rejects half-written rows |
| `lib/identity/mesh.ts` | After SIWE: reuse or mint pair; persist wrap; unwrap for use |
| `lib/identity/wagmi.ts` | Injected-only wagmi config |
| `app/api/identity/nonce` | `GET` — issue nonce cookie, return `{ nonce }` |
| `app/api/identity/verify` | `POST` `{ message, signature }` — verify SIWE, set session |
| `app/api/identity/session` | `GET` — current `{ address, chainId }` or 401 |
| `app/api/identity/logout` | `POST` — clear identity cookies |
| `components/IdentityBar.tsx` | Quiet `/feed` connect + SIWE + mesh key + wrap/unlock + sign out |

## Cookies

App Service has more than one instance. The nonce **must** be in a signed cookie, not process memory.

| Cookie | Prefix | Payload |
| --- | --- | --- |
| `s3rch-nonce` | `__Host-` on HTTPS, `Host-` on HTTP | jose JWT `{ nonce, iat, exp }` — a few minutes |
| `s3rch-session` | same | jose JWT `{ address, chainId, iat, exp }` |

`__Host-` requires `Secure`, `Path=/`, and no `Domain` attribute. That is the strongest prefix that works on `https://s3r.ch`. It does not set on `http://localhost`, so local HTTP uses `Host-s3rch-*` with `Secure` off. Readers accept either name.

Flags: HttpOnly, SameSite=Lax, Path=/, Secure on HTTPS.

Do not set `rp.id` to a parent domain. That would be a different host than these cookies.

## `IDENTITY_SESSION_SECRET`

HMAC key for both cookies. **Minimum 32 characters.**

- **Production:** if missing or too short, `POST /api/identity/verify` (and the other identity routes that sign/read cookies) return **500** and log a clear error. Auth is not silently disabled.
- **Non-production:** if the env var is unset, a documented local fallback is used so `next dev` works. Do not use that fallback in production.

Operator step (not in this PR): set `IDENTITY_SESSION_SECRET` on the Azure App Service (Key Vault later). **Still operator / Azure.** Build and CI must not require it and must not fake it. This wrap slice does not change that.

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

## WebAuthn PRF wrap (recovery, not login)

Passkey **PRF** (WebAuthn Level 3 `extensions.prf`) is **recovery / device proof**. It does not replace SIWE and is not the session subject.

### Envelope v1

Stored in origin IndexedDB only (`s3rch-identity` / `mesh-keys`). When wrapped, the plaintext `seaPair` field is **removed**.

- Random 32-byte DEK encrypts canonical SEA pair JSON with **AES-256-GCM**.
- DEK is wrapped by **two** KEKs, each AES-256-GCM:
  - **PRF KEK** — HKDF-SHA-256 of the authenticator PRF output.
  - **Secondary KEK** — HKDF-SHA-256 of a wallet signature (lab default) or a paper backup secret.
- HKDF info string is exactly `s3r.ch/sea-wrap/aes-gcm/v1`. Never use raw PRF bytes as the AES key.
- Fields: `rpId`, `credentialId`, PRF salt, optional secondary salt, wrapped DEKs, ciphertext, alg ids, checksummed address + `seaPub` binding.
- `rp.id` = `s3r.ch` in production. Localhost may use `localhost` (or `127.0.0.1` on that origin). Per-origin. Same host allowlist as SIWE.

Secondary in the lab UI: the injected wallet already in IdentityBar signs a domain-bound statement that includes a stored secondary salt. That signature's bytes are the secondary IKM. A paper export string (`s3rch-wrap-v1:<base64url>`) uses the same wrap slot in code.

### IndexedDB migration

A row is **either** legacy plaintext **or** wrapped — never both. `isHalfWrittenMeshKeyRecord` / `assertCompleteMeshKeyRecord` reject:

- `seaPair` and `wrap` together
- neither payload
- a wrap object missing required fields
- address / `seaPub` mismatch between row and envelope

Reading the pair for use: plaintext returns immediately; wrapped must unwrap with PRF or secondary.

Sign-out clears the session cookie only. It **must not** delete the IndexedDB record.

### Authenticator support

Lab-real targets:

- Chrome with Google Password Manager PRF
- Safari iCloud Keychain (macOS 15+ / iOS 18.4+)

If PRF is unavailable, the UI shows a clear message and **does not fake a wrap**. The plaintext pair stays on disk until a real PRF wrap succeeds.

Not credBlob. Not largeBlob.

### Quiet UI (`/feed` IdentityBar)

After signed-in + mesh key present:

- `Wrap with passkey` when the record is plaintext and PRF is not known-unavailable
- `Unlock mesh key` / `mesh key wrapped` / `mesh key unlocked` when wrapped
- Degrade copy when PRF is missing
- Do not dump `priv` / `epriv`

## Local SEA mesh key (after SIWE)

After `POST /api/identity/verify` succeeds, the client:

1. Looks up this checksummed address in origin IndexedDB (`s3rch-identity` / `mesh-keys`).
2. **Reuses** the stored pair + wallet-signed link when present (plaintext or wrapped; does not mint a new pair every sign-in).
3. Otherwise calls `createSeaPair()` (`gun/sea` `SEA.pair()`, P-256, not the Ethereum key), asks the connected wallet to sign a short domain-bound statement that this `pub` belongs to this address, and saves `{ address, seaPub, seaPair, walletSignature, signedPayload }` in IndexedDB.

Legacy lab records may still be **plaintext in IndexedDB**. PRF wrap replaces that `seaPair` field when the user wraps.

Locks that stay:

- Never `sessionStorage`.
- Never `user.recall({ sessionStorage: true })`.
- Never write SIWE signatures, SEA `priv` / `epriv`, the envelope, DEK, KEKs, or the link onto the public Gun graph.
- Session subject remains the checksummed address.

## Follow-ups

- WalletConnect injected-or-QR, gated on `NEXT_PUBLIC_WC_PROJECT_ID`.
- ERC-1271 / EIP-6492 via a pinned RPC.
- Paper-backup UI for the secondary slot (code already accepts a paper string).
- Public indicators (ENS reverse, Farcaster) **after** auth, as held claims.
- SociACL Check when sharing needs grants (adapter lives outside this repo).
- Azure Key Vault for `IDENTITY_SESSION_SECRET` (still operator / Azure in this slice).
