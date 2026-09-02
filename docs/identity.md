# s3r.ch user identity (2026-09-01)

Source of truth for login on this Next app. Product decisions agreed with Chris Hamilton (cchamilt).

This kit is **s3r.ch login** and, later, a Hypermesh **wallet door**. The Hypermesh portal stays Keycloak. Do not bolt OIDC onto s3r.ch as primary login.

Components here are written so they can be extracted into a shared kit later. The first implementation lives in this repo.

## What this slice ships

- EIP-4361 **Sign-In with Ethereum** (SIWE).
- Signed **HttpOnly cookie session** bound to a **checksummed** Ethereum address (never ENS, never email, never a SEA pub).
- Quiet connect / sign-in / sign-out on `/feed` (injected wallet by default).
- **WalletConnect** (QR / mobile) as a second wagmi connector, **gated** on `NEXT_PUBLIC_WC_PROJECT_ID` at **build time**. Empty / unset stays injected-only. WalletConnect is a connector, not a new identity provider. Sign-in is still SIWE after a session address exists.
- After the SIWE session is set: a **local Gun SEA P-256 pair** (different curve from Ethereum) plus a **wallet-signed link** (`pub` belongs to this checksummed address), persisted in **origin IndexedDB**.
- **WebAuthn PRF wrap** of that local pair (recovery / device proof, **not** login). Envelope version 1 in IndexedDB, with ≥2 KEKs (PRF + secondary). Quiet `/feed` controls: wrap / unlock / paper backup / status.
- After a SIWE session exists: a **mainnet ENS held claim** on `/feed` when reverse **and** forward match the checksummed session address. ENS is never login and never the session key.
- After a SIWE session exists: a **Polygon UNS Unstoppable held claim** on `/feed` when reverse **and** forward checksum-match the session address. Unstoppable is never login and never the session key. SNS / Solana names are not this slice.
- After a SIWE session exists: **Farcaster / Lens / RSS3 held claims** on `/feed` when a bidirectional public lookup binds them to the checksummed session address. These are never login (no SIWF, no Lens OAuth, no RSS3 login) and never the session key.
- **ERC-1271** (and EIP-6492 via the same viem path) so a smart-account wallet can SIWE. Session subject stays the checksummed contract or EOA address.
- **Paper-backup UI** for the wrap secondary KEK (`s3rch-wrap-v1:<base64url>`). Recovery, not login. Random 32-byte paper IKM (not a wallet-signature export). Shown once on wrap/export; paste unlocks.
- Light SociACL **Check see-grants** in the browser (`CHECK(see, object, accessor)` at `now`). Quiet `/feed` grant / revoke after SIWE. Grants are `IdentitySeeGrant` records on an in-memory / IndexedDB dest ACL. Not login.

## What this slice does not ship

- Passkey as primary login. Session subject stays the checksummed address.
- Writing the envelope, DEK, KEKs, SIWE signatures, or SEA `priv` / `epriv` to Gun for recovery.
- A paper-only wrap that drops the PRF KEK. Paper replaces the **secondary** IKM only.
- A Reown Cloud project id invented in this repo. Empty `NEXT_PUBLIC_WC_PROJECT_ID` stays injected-only.
- Panopticon / Hypermesh Keycloak as an IdP. s3r.ch login stays EIP-4361 SIWE.
- ENS or Unstoppable as login, or writing an ENS / Unstoppable / Farcaster / Lens / RSS3 claim onto the public Gun graph.
- A UD partner key in `NEXT_PUBLIC_*`, a browser call to `api.unstoppabledomains.com/resolve`, or Key Vault for `UNSTOPPABLE_API_KEY`.
- Farcaster SIWF, Lens OAuth, or RSS3 login. Indicators are held claims after SIWE, not session subjects.
- Importing `FyberLabs/SociACL` as a crate, NAPI, WASM, or npm package. Light Check is re-typed from the consume contract (`docs/s3rch-check.d.ts`).
- Friend-of-friend, Social Light hop UI, Elect / wills / Case C, or any verb beyond `see`.
- NextAuth, Keycloak, or email magic link on this app.
- Changing seed Gun, Cloudflare, GitHub Actions, or `lib/auth.ts` seed helper (that file is `SEED_SECRET` only).

## Locks

| Lock | Why |
| --- | --- |
| Session key is the checksummed address | ENS, Unstoppable name, fname, Lens handle, RSS3 id, email, Keycloak `sub`, and SEA `pub` are never the session subject. EOA or ERC-1271 contract address only |
| Contract SIWE is mainnet ERC-1271 / EIP-6492 | Local Anvil is EOA-only. Do not send a local contract `eth_call` to mainnet |
| ENS is a held claim after SIWE | Reverse + forward must checksum-match. Unverified reverse is never shown |
| Unstoppable is a held claim after SIWE | Same bidirectional bar as ENS, on Polygon UNS. Never login. Empty `UNSTOPPABLE_API_KEY` is a quiet empty when on-chain misses, not a reason to drop ENS or other claims |
| Farcaster / Lens / RSS3 are held claims after SIWE | Same bidirectional bar as ENS. Unverified one-way lookups are never shown. A GI miss is a quiet empty RSS3 claim, not a reason to drop the others |
| Mesh identity is a **local Gun SEA P-256 pair**, not the Ethereum key | Different curves. Ethereum secp256k1 signs SIWE; SEA is for later mesh crypto |
| Never call `user.recall({ sessionStorage: true })` | Gun would store the plaintext SEA pair. Never `sessionStorage` for this kit. |
| Never put SIWE signatures, SEA `priv` / `epriv`, the envelope, DEK, KEKs, ENS, Unstoppable, Farcaster, Lens, or RSS3 claims on the public Gun graph | Session / device secrets stay in cookies and IndexedDB. Public indicators are read-only this slice |
| Nonce lives in a **signed cookie**, not an in-memory `Map` | Azure App Service is multi-instance; Redis is not in this slice |
| OIDC is not primary login | Hypermesh portal can stay Keycloak; s3r.ch does not use Panopticon Keycloak as an IdP |
| Passkey WebAuthn PRF wrap is recovery | PRF is device proof. It does not become the session subject |
| Paper backup is recovery | Same wrap slot as wallet secondary. Never login. Never persist the paper string, DEK, KEKs, or SEA `priv` / `epriv` in Gun, cookies, or `sessionStorage` |
| `lib/auth.ts` is seed authorize | User identity lives in `lib/identity/` |
| Check is grants, not login | Session subject stays the checksummed address. A live `IdentitySeeGrant` is not a session. hopcap 1. Revoke is immediate. URL 200 / ingest / seeder fetch is not `see` |
| Dest ACL is local | See-grants live in memory / origin IndexedDB. Never write SIWE signatures, SEA `priv` / `epriv`, wrap envelopes, or paper strings onto public Gun |

## Libraries

Pinned to current majors compatible with Next.js 16, React 19, and Node 24:

| Package | Role |
| --- | --- |
| `siwe` | Construct and parse EIP-4361 messages |
| `viem` | EOA `verifyMessage` (local ecrecover, no RPC). Contract verify via mainnet `publicClient.verifyMessage` (ERC-1271 + EIP-6492). Checksum via `getAddress`. Mainnet `getEnsName` + `getEnsAddress`. Polygon UNS `reverseNameOf` + `get("crypto.ETH.address")` |
| `wagmi` v3 | Injected connector always. `walletConnect` only when `NEXT_PUBLIC_WC_PROJECT_ID` is set. No RainbowKit, no ConnectKit |
| `@walletconnect/ethereum-provider` | Optional peer for the wagmi WalletConnect connector. Unused at runtime when the project id is empty |
| `@tanstack/react-query` | Required by wagmi |
| `jose` | Sign nonce and session cookies (HS256) |
| `gun` / `gun/sea` | Already a dependency. `createSeaPair()` calls `SEA.pair()` after SIWE. Persist in IndexedDB, not `recall()` |

No SimpleWebAuthn. The PRF helper uses native `navigator.credentials.create` / `get` with `extensions.prf`.

WalletConnect is **gated**. Do not invent a Reown project id in this repo or in CI. An empty `NEXT_PUBLIC_WC_PROJECT_ID` (the default) keeps the Docker image injected-only.

## Module map

| Path | Job |
| --- | --- |
| `lib/identity/config.ts` | TTLs, statement, allowed SIWE hostnames, cookie name prefixes |
| `lib/identity/secret.ts` | `IDENTITY_SESSION_SECRET` (min 32 chars). Local fallback only when unset and not production |
| `lib/identity/cookies.ts` | `__Host-` on HTTPS, `Host-` on HTTP localhost. HttpOnly, SameSite=Lax, `Path=/` |
| `lib/identity/nonce.ts` | Random SIWE nonce + signed cookie payload |
| `lib/identity/session.ts` | Signed session `{ address, chainId, iat, exp }` |
| `lib/identity/siwe.ts` | Parse, domain/nonce/expiry checks, EOA ecrecover then ERC-1271 / EIP-6492 |
| `lib/identity/wrap.ts` | Envelope v1 + HKDF-then-AES-GCM wrap/unwrap of the SEA pair |
| `lib/identity/webauthn-prf.ts` | Native WebAuthn PRF create/get. Refuses to fake a wrap |
| `lib/identity/sea.ts` | `createSeaPair()` — local P-256 pair. Does not `recall()` |
| `lib/identity/mesh-link.ts` | Domain-bound statement: this SEA `pub` belongs to this address |
| `lib/identity/idb.ts` | Origin IndexedDB: plaintext **or** wrapped record. Rejects half-written rows |
| `lib/identity/mesh.ts` | After SIWE: reuse or mint pair; persist wrap; unwrap for use |
| `lib/identity/wagmi.ts` | Injected wagmi config; `walletConnect` only when `walletConnectProjectId()` is non-null |
| `lib/identity/ens.ts` | Mainnet ENS reverse + forward held claim. Mockable public-client surface |
| `lib/identity/unstoppable.ts` | Polygon UNS Unstoppable reverse + forward held claim. Mockable client (on-chain + optional Resolution fallback) |
| `lib/identity/farcaster-claim.ts` | Hubble custody reverse + FID registry forward. Display fname or `fid:N` |
| `lib/identity/lens-claim.ts` | Public Lens GraphQL owned-account reverse + owner forward |
| `lib/identity/rss3-claim.ts` | Optional GI overlay reverse + owner forward. Quiet label, not a feed |
| `lib/identity/indicators.ts` | Session-gated Farcaster / Lens / RSS3 in one trip. Isolates GI misses |
| `lib/identity/check.ts` | Consume-contract Check: `checkSee`, `checkSeeGrant`, `applySeeGrant`, `cancelSee`, `admitFeedNode`, `acceptHint`, souls |
| `lib/identity/see-acl.ts` | Lab dest ACL (memory + IndexedDB). `IdentitySeeGrant` records only |
| `lib/identity/held-claims.ts` | Claim ids linked from the user node (`ens:name.eth`, `unstoppable:brad.x`). Not `s3rch/users/{wallet}/claims/…` |
| `app/api/identity/nonce` | `GET` — issue nonce cookie, return `{ nonce }` |
| `app/api/identity/verify` | `POST` `{ message, signature }` — verify SIWE, set session |
| `app/api/identity/session` | `GET` — current `{ address, chainId }` or 401 |
| `app/api/identity/ens` | `GET ?address=` — session-gated ENS claim for the session address only |
| `app/api/identity/unstoppable` | `GET ?address=` — session-gated Unstoppable claim for the session address only |
| `app/api/identity/indicators` | `GET ?address=` — session-gated Farcaster / Lens / RSS3 claims for the session address only |
| `app/api/identity/logout` | `POST` — clear identity cookies |
| `components/IdentityBar.tsx` | Quiet `/feed` connect + optional WalletConnect + SIWE + mesh key + wrap/unlock + paper backup + ENS + Unstoppable + public-indicator claims + see-grant / revoke + sign out |
| `components/SeeGrantControls.tsx` | Signed-in grant see / revoke of a held claim (wallet / ENS / Unstoppable / FC / Lens / RSS3). Copy: this is a grant, not login. No hop UI |

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
6. Verify the signature:
   - Local EOA `ecrecover` first (viem `verifyMessage` utility, no RPC). Anvil / local keys stay here.
   - If that fails and SIWE `chainId` is mainnet (`1`), call viem `publicClient.verifyMessage` on a `createPublicClient({ chain: mainnet, transport: http() })` — same unpinned public HTTP as ENS. That path is ERC-1271 (`isValidSignature` magic `0x1626ba7e`) and EIP-6492 (viem's deployless wrapper). Tests inject a mockable client so they never hit live RPC.
   - Any other `chainId` (including Anvil `31337` / Hardhat `1337`) is EOA-only. Do not send a local contract call to mainnet.
7. On success, the checksummed message address (EOA or contract) is the session subject. Cookie is still `{ address, chainId, iat, exp }`. Never ENS, email, Keycloak `sub`, or SEA `pub`.

RPC errors and a non-magic / false ERC-1271 result are a quiet invalid signature (401), not a 500 dump.

Reject on domain mismatch. Do not treat ENS names as the session key.

s3r.ch does **not** use Panopticon Keycloak as an IdP and does not federate to hyperme.sh. SociACL Check is **grants**, not login. The session subject stays the checksummed address. See [s3rch-check.md](s3rch-check.md).

## ENS held claim (after SIWE, not login)

Show a mainnet ENS name only **after** the SIWE cookie session exists. The session subject stays the checksummed address.

Require **forward + reverse** before treating a name as a held claim:

1. Reverse: session address → name (`getEnsName`).
2. Forward: that name → address (`getEnsAddress`) must be **checksum-equal** to the session address.

If either lookup fails or the forward address mismatches, show nothing (quiet empty / no ENS claim). Do **not** display an unverified reverse. Do not dump RPC errors into the `/feed` hero.

This slice is **mainnet ENS only**. A `createPublicClient({ chain: mainnet, transport: http() })` uses the same default public HTTP transport as `lib/identity/wagmi.ts`. No Alchemy / Infura / Azure secret. If that default flakes in the lab, pin a public HTTP URL in `createMainnetEnsClient()`. Unstoppable is a separate held claim (below), not a replacement for ENS. SNS is not this slice.

`GET /api/identity/ens?address=` is session-gated. The query address, when present, must match the session subject. The route does not become an open ENS proxy and does **not** write the claim onto the public Gun graph.

IdentityBar caches the claim in component state for the current session (no Redis). Quiet line format: `ENS claim: name.eth` or nothing. `vitalik.eth` ↔ `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` still reverse+forward as of 2026-09-01 and is the documented format example — not a screenshot subject for Anvil.

## Unstoppable held claim (after SIWE, not login)

Show a Polygon UNS Unstoppable name only **after** the SIWE cookie session exists. The session subject stays the checksummed address. Unstoppable is **never login** and never the session key. Same bar as ENS.

Require **forward + reverse** before treating a name as a held claim:

1. Reverse: session address → name (`ProxyReader.reverseNameOf`).
2. Forward: that name → `crypto.ETH.address` must be **checksum-equal** to the session address.

If either lookup fails or the forward address mismatches, show nothing (quiet empty / no Unstoppable claim). Do **not** display an unverified reverse. Do not dump RPC or Resolution Service errors into the `/feed` hero. An empty Unstoppable claim must not drop ENS / Farcaster / Lens / RSS3.

### On-chain (preferred, no partner key)

`createPublicClient({ chain: polygon, transport: http() })` — same unpinned public HTTP pattern as ENS on mainnet. No Alchemy / Infura / Azure secret. No UD partner key.

Official current Polygon (chain 137) addresses, from Unstoppable `uns-config.json` v0.9.11 (resolution `src/config`, re-checked 2026-09-02) and the [UNS reverse-resolve docs](https://docs.unstoppabledomains.com/web3/smart-contracts/quick-start/reverse-resolve-domains):

| Contract | Address | Role |
| --- | --- | --- |
| **ProxyReader** (current) | `0x91EDd8708062bd4233f4Dd0FCE15A7cb4d500091` | `reverseNameOf` + `get` |
| **UNSRegistry** | `0xa9a6A3626993D487d2Dbda3173cf58cA1a9D9e9f` | IReverseRegistry lives here; no separate ReverseResolution deployment in current UNS config |
| ProxyReader (legacy) | `0x423F2531bd5d3C3D4EF7C318c2D1d9BEDE67c680` | Still cited in UD docs; listed as `legacyAddresses`. Do not call it |

If the default Polygon public HTTP flakes in the lab, pin a public HTTP URL in `createPolygonUnstoppableClient()` — do not invent a partner key or put one in `NEXT_PUBLIC_*`.

Hosted Resolution Service (`api.unstoppabledomains.com/resolve`) requires a Bearer API key and is **not** for the browser (CORS + key).

### Session-gated route + optional Resolution fallback

`GET /api/identity/unstoppable?address=` is session-gated. The query address, when present, must match the session subject. The route does not become an open UD proxy and does **not** write the claim onto the public Gun graph.

If on-chain reverse/forward **throws** (RPC miss), the route may fall back to Resolution Service **only** when `UNSTOPPABLE_API_KEY` is set on the server. A successful empty reverse is final — do not shop a second source. Empty / unset key = quiet empty (same class as an RSS3 GI miss). Never send the key to the client. Do not add Key Vault in this slice.

IdentityBar fetches after the SIWE session (separate from ENS / indicators) and caches the claim in component state (no Redis). Quiet line format: `Unstoppable claim: name.crypto` (or whatever TLD the verified name uses) or nothing. Tests use a dummy `0xCcCC…cccC`. `brad.x` ↔ `0x8aaD44321A86b170879d7A244c1e8d360c99DdA8` still reverse+forwards on Polygon ProxyReader as of 2026-09-02 and is the documented format example — not a screenshot subject. The UD docs wallet `0x88bc…` still reverse-resolves `jim-unstoppable.x` but its `crypto.ETH.address` does **not** checksum-match, so it is not a fixture.

### Operator path (`UNSTOPPABLE_API_KEY`, optional)

1. Create a Resolution Service API key from the Unstoppable partner / API panel (backend key, not a browser key).
2. Set `UNSTOPPABLE_API_KEY` on the Azure App Service **runtime** env (not `NEXT_PUBLIC_*`, not Docker build-arg). Local: `.env.local`.
3. Leave it empty if you do not have a key. On-chain stays the preferred path; a miss stays quiet.
4. Key Vault later — not this PR.

SNS / Solana names are **not** this slice.

## Farcaster / Lens / RSS3 held claims (after SIWE, not login)

Show these only **after** the SIWE cookie session exists. The session subject stays the checksummed address. No Farcaster SIWF, no Lens OAuth, no RSS3 login.

Require a **bidirectional** check before treating anything as a held claim (same bar as ENS). Unverified one-way lookups are never shown. Hub / GraphQL / GI errors are swallowed — never dumped into the `/feed` hero.

| Source | Reverse | Forward | Quiet line |
| --- | --- | --- | --- |
| **Farcaster** | Hubble `onChainIdRegistryEventByAddress` (current custody → FID) | Hubble `onChainEventsByFid` latest id-registry `to` checksum-equals the session | `Farcaster claim: fname` or `fid:N` from USER_DATA |
| **Lens** | Public `https://api.lens.xyz/graphql` `accountsAvailable` **AccountOwned** | `account(request: { address })` `owner` checksum-equals the session | `Lens claim: handle` |
| **RSS3** | Optional GI `GET /decentralized/{account}` | At least one activity `owner` checksum-equals the session | `RSS3 claim: footprint` or a short platform set |

Public HTTP only. Reuse the feed's Pinata Hubble base (`FARCASTER_HUB_BASE`) and optional `GI_BASE`. No Neynar, no Alchemy/Infura, no Azure RPC secret, no Redis. Seeders (`lib/farcaster.ts`, `lib/rss3.ts`) stay seeders — identity does not turn them into a login path or write their payloads onto Gun.

Hubble reverse is **custody**. A verified-only ETH address with no current id-registry record is a quiet empty (no paid reverse index).

RSS3 GI (`https://gi.rss3.io`) is optional / currently DNS-dead. A GI miss is a quiet empty RSS3 claim, **not** a reason to drop Farcaster or Lens. Do not dump GI account activity, casts, or tx graphs as identity.

`GET /api/identity/indicators?address=` is session-gated. The query address, when present, must match the session subject. The route does not become an open Farcaster / Lens / RSS3 proxy. ENS stays on `GET /api/identity/ens` and Unstoppable stays on `GET /api/identity/unstoppable` (unchanged verification rules). IdentityBar fetches ENS, Unstoppable, and this one indicators route after session — not three extra uncoordinated indicator trips — and caches results in component state (no Redis).

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

Secondary IKM is either:

- **wallet** (lab default): the injected wallet signs a domain-bound statement that includes a stored secondary salt. Those signature bytes are the secondary IKM.
- **paper**: a random 32-byte IKM, shown once as `s3rch-wrap-v1:<base64url>`. The user keeps the string. It is never written to Gun, cookies, `sessionStorage`, or IndexedDB.

Do **not** export a wallet signature as paper. Wallet bytes are easy to screenshot and are not a recovery secret people should copy. Wrap-with-paper (checkbox on first wrap) or Export paper backup (re-wrap an existing envelope) uses a fresh random IKM and sets `secondaryKind: "paper"`. The string can unwrap this envelope; a wallet-kind envelope cannot be unlocked with a made-up paper string.

Paper is **recovery**, not login. Session subject stays the checksummed address. Envelope still needs ≥2 KEKs (PRF + secondary). If PRF is unavailable, paper can still unwrap a wrapped record that has a secondary slot. The UI does not fake a PRF wrap.

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

Signed-out: **Connect wallet** (injected). When `NEXT_PUBLIC_WC_PROJECT_ID` is set at build time, a quiet second **WalletConnect** control appears. Sign in with Ethereum still runs after a session address exists.

After signed-in + mesh key present:

- `Wrap with passkey` when the record is plaintext and PRF is not known-unavailable
- Optional `also show a paper backup` on wrap: PRF + random paper secondary (not wallet)
- `Unlock mesh key` (PRF, then wallet secondary when present)
- Paste field + `Unlock with paper` when wrapped and locked; clear the paste after success
- `Export paper backup` when wrapped and PRF is not known-unavailable: re-wrap with a new paper IKM, show `s3rch-wrap-v1:` once (copyable), then the user keeps it
- Degrade copy when PRF is missing; paper unlock still works
- After SIWE: quiet `ENS claim:` / `Unstoppable claim:` / indicator lines when verified. Empty Unstoppable does not drop the others
- Do not dump `priv` / `epriv`, the paper string as a standing `/feed` hero line, or invalid-paste dumps
- After SIWE: quiet **Grant see** / **Revoke** for a held claim (wallet / ENS / Unstoppable / …) to another checksummed address and a time window. Copy: this is a grant, not login. No hop UI

## Local SEA mesh key (after SIWE)

After `POST /api/identity/verify` succeeds, the client:

1. Looks up this checksummed address in origin IndexedDB (`s3rch-identity` / `mesh-keys`).
2. **Reuses** the stored pair + wallet-signed link when present (plaintext or wrapped; does not mint a new pair every sign-in).
3. Otherwise calls `createSeaPair()` (`gun/sea` `SEA.pair()`, P-256, not the Ethereum key), asks the connected wallet to sign a short domain-bound statement that this `pub` belongs to this address, and saves `{ address, seaPub, seaPair, walletSignature, signedPayload }` in IndexedDB.

Legacy lab records may still be **plaintext in IndexedDB**. PRF wrap replaces that `seaPair` field when the user wraps.

Locks that stay:

- Never `sessionStorage`.
- Never `user.recall({ sessionStorage: true })`.
- Never write SIWE signatures, SEA `priv` / `epriv`, the envelope, DEK, KEKs, the paper backup string, the link, or ENS / Unstoppable / Farcaster / Lens / RSS3 claims onto the public Gun graph.
- Session subject remains the checksummed address. Paper backup is recovery, not login.

## WalletConnect (gated connector, not an IdP)

This slice ships WalletConnect **gated** on `NEXT_PUBLIC_WC_PROJECT_ID`. Injected stays the default. If the env is unset or empty, `/feed` is exactly as before (Connect wallet + "No injected wallet found."). If it is set (non-empty) at **build time**, IdentityBar shows a quiet second **WalletConnect** control. Sign-in is still SIWE after a wagmi session address exists (injected or WalletConnect). Session subject stays the checksummed address. No Keycloak, no RainbowKit, no ConnectKit.

Next.js inlines `NEXT_PUBLIC_*` at `next build`. s3r.ch builds inside Docker (`Dockerfile` builder stage). App Service **runtime** env will not inject this into the client bundle. The Dockerfile takes `ARG NEXT_PUBLIC_WC_PROJECT_ID` and sets `ENV` **before** `npm run build`. Deploy passes `build-args: NEXT_PUBLIC_WC_PROJECT_ID=${{ vars.NEXT_PUBLIC_WC_PROJECT_ID }}` (GitHub **variable**, not secret — this id is public, same class as `SEED_URL`). A missing variable must not fail the build (empty ARG → injected-only).

Local: copy `.env.example` to `.env.local`. `next dev` reads `.env.local`. Do not commit a real id.

### Operator path (do not invent an id)

1. Create a Reown Cloud project at https://cloud.reown.com named `s3r.ch`.
2. Allow `https://s3r.ch` and `http://localhost:3000`.
3. Copy the Project ID.
4. Put it in FyberLabs/infra `config/infra.yaml` `apps.s3rch_wc_project_id` (public, same class as `stripe_publishable_key`). Sync with `python3 scripts/sync-github-secrets.py --repo-only --apply` so GitHub variable `NEXT_PUBLIC_WC_PROJECT_ID` lands on FyberLabs/s3r.ch.
5. Local: `.env.local`. Prod: redeploy so Docker rebuilds with the build-arg.

A sibling infra PR will add the variable mapping. Until that id exists, leave the env empty.

## Light Check see-grants (grants, not login)

After SIWE, the holder can grant `see` of a held claim (wallet, ENS, Unstoppable, Farcaster, Lens, RSS3) to another checksummed address for a time window, and revoke immediately. Session subject stays the checksummed address. Copy: **this is a grant, not login.**

Source of truth: [s3rch-check.md](s3rch-check.md) / [s3rch-check.d.ts](s3rch-check.d.ts), matching FyberLabs/SociACL `crates/sociacl-gun` consume contract. Do not import that crate.

`CHECK(see, object, accessor)` at `now`:

- Owner sees their object.
- Else a live `IdentitySeeGrant` must name the pair and `now ∈ [from, until)` (`until` exclusive).
- Hint never sets `allowed`. hopcap **1** — do not walk friend edges.
- `meta` and `UrlLeaf` fail closed. A URL 200 is not `see`.
- `admitFeedNode` re-authorizes at dest before `put` into `items`.
- Privilege-down (`cancelSee`) is immediate.

Dest ACL is lab-local (memory / IndexedDB). Grants are `IdentitySeeGrant` records only. Public mesh vs mine still applies: a grant is not share-into-mesh and is not written onto public Gun.

Claim object id is the claim id, linked from the user node (`ens:name.eth`). Do not invent `s3rch/users/{wallet}/claims/…`.

Quiet `/feed` IdentityBar: grant see + revoke after SIWE. No hop UI. No Elect / wills / Case C. Social Light hop is not this slice (it can factor a Check later; it cannot mint a grant).

## Follow-ups

- SNS / Solana names (not this slice; ENS remains primary mainnet reverse+forward. Unstoppable is a held claim after SIWE, not login).
- More Check verbs, Social Light hop (may factor a Check later; it cannot mint a grant), friend-of-friend. Do not import `FyberLabs/SociACL`.
- Azure Key Vault for `IDENTITY_SESSION_SECRET` and later `UNSTOPPABLE_API_KEY` (still operator / Azure in this slice).
- Contract verify on chains other than mainnet (this slice's 1271 RPC allowlist is mainnet only).

This slice ships an Unstoppable held claim after SIWE (Polygon on-chain reverse+forward; optional server-only Resolution key), paper-backup UI for the wrap secondary KEK, ERC-1271 (and EIP-6492 via the same viem `verifyMessage` client), WalletConnect gated on `NEXT_PUBLIC_WC_PROJECT_ID`, and light SociACL Check see-grants (consume contract in [s3rch-check.md](s3rch-check.md)). Check is grants, not login. Unstoppable is never login. s3r.ch does not use Panopticon Keycloak as an IdP.

## Live fixtures (re-checked 2026-09-01)

Do not keep a live identity as a fixture unless the public API still confirms it. Dummy `0xcc…cc` is fine when clearly fake.

| Citation | Check | Result |
| --- | --- | --- |
| `vitalik.eth` ↔ `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | ENS reverse + forward | Still matches. Format example only. |
| `brad.x` ↔ `0x8aaD44321A86b170879d7A244c1e8d360c99DdA8` | Polygon UNS reverse + `crypto.ETH.address` (ProxyReader `0x91EDd…091`, 2026-09-02) | Still matches. Format example only. Do not screenshot. |
| Lens `vitalik` / account `0xe4AaA97cdA406c6AF7C02a5260a8013910bd683C` | `api.lens.xyz/graphql` owned + owner | Still owned by `0xd8dA…`. |
| Farcaster `0xD7029Bdea1c17493893AAfE29Aad69ef892B8FF2` | Pinata Hubble id-registry | Still fid **188133** custody. USER_DATA empty; tests use a mock fname (`dwr-alt`), not a live username. |
| Farcaster fid 3 (`dwr`) | Hubble id-registry | Custody is `0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1`, **not** `0xd702…`. |
| Anvil `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Lens GraphQL | Well-known test key. Currently owns Lens handles (`nr0868889`, …) — **public-key collision**, not a product example. Do not screenshot it as a held claim. No ENS name. |
| `FARCASTER_HUB_BASE` `https://hub.pinata.cloud` | HTTP `/v1/info` | Live (hub `0.14.2`). |
| `https://api.lens.xyz/graphql` | GraphQL | Live. |
| `GI_BASE` `https://gi.rss3.io` | DNS | Still no A/AAAA/CNAME. Keep optional / quiet empty. Do not pretend it is up. |
