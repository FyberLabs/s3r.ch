# s3r.ch user identity (2026-09-08)

Source of truth for login on this Next app. Product decisions agreed with Chris Hamilton (cchamilt).

This kit is **s3r.ch login** and, later, a Hypermesh **wallet door**. The Hypermesh portal stays Keycloak. Do not bolt OIDC onto s3r.ch as primary login.

Components here are written so they can be extracted into a shared kit later. The first implementation lives in this repo.

## What this slice ships

- EIP-4361 **Sign-In with Ethereum** (SIWE).
- Signed **HttpOnly cookie session** bound to a **checksummed** Ethereum address (never ENS, never email, never a SEA pub).
- Quiet connect / sign-in / sign-out on `/feed` (injected wallet by default).
- **Coinbase Smart Wallet onramp** (wagmi `coinbaseWallet` with `preference.options: "smartWalletOnly"`). Ungated — no project id. Creates or opens a passkey smart account so someone not in crypto yet can get an address, then SIWE as today. Not a second IdP. Not email/phone login. Not `@coinbase/cdp-wagmi`.
- **WalletConnect** (QR / mobile) as a wagmi connector, **gated** on `NEXT_PUBLIC_WC_PROJECT_ID` at **build time**. Empty / unset keeps injected + Smart Wallet (no WalletConnect). WalletConnect is a connector, not a new identity provider. Sign-in is still SIWE after a session address exists.
- After the SIWE session is set: a **local Gun SEA P-256 pair** (different curve from Ethereum) plus a **wallet-signed link** (`pub` belongs to this checksummed address), persisted in **origin IndexedDB**.
- **WebAuthn PRF wrap** of that local pair (recovery / device proof, **not** login). Envelope version 1 in IndexedDB, with ≥2 KEKs (PRF + secondary). Quiet `/feed` controls: wrap / unlock / paper backup / status.
- After a SIWE session exists: a **mainnet ENS held claim** on `/feed` when reverse **and** forward match the checksummed session address. ENS is never login and never the session key.
- After a SIWE session exists: a **Polygon UNS Unstoppable held claim** on `/feed` when reverse **and** forward checksum-match the session address. Unstoppable is never login and never the session key. SNS / Solana names are not this slice.
- After a SIWE session exists: **Farcaster / Lens / RSS3 held claims** on `/feed` when a bidirectional public lookup binds them to the checksummed session address. These are never login (no SIWF, no Lens OAuth, no RSS3 login) and never the session key.
- After a SIWE session exists: **email / phone confirm** and a **fixture KYC attestation** as private held claims (`email:…` / `phone:…` / `kyc:<issuer>:…`). Session-gated. Never login. Verification proof stays in origin IndexedDB. Claim id links on the Mine overlay. Public Gun only after explicit share of that claim id. Live send is `CONFIRM_SEND_URL` (empty = honest "not configured"; non-production uses lab code `000000` unless `CONFIRM_FIXTURE=0`). A real KYC issuer is `KYC_ISSUER_URL` (empty keeps the fixture stub). Not a passport upload.
- After a SIWE session exists: a **Gun user node** (`GunUserNode` on `s3rch/users/<wallet>`, `v: 1`). Verified held indicators **assemble/update the Mine overlay** with linked claim ids after successful lookups (wallet + ENS / Unstoppable / Farcaster / Lens / RSS3) and after email / phone / KYC confirm. That overlay is local Gun-shaped state (dest ACL + origin IndexedDB) — not session-display-only, and **not** an automatic public put. Explicit share-into-mesh of the user node or of an individual claim is confirm + admit + put — same pattern as a native post or room. Holding a claim is not publishing it. Unshare retracts the user node (tombstone) or republishes without one claim. Session chrome shows **Held.** vs **Public.** without architecture essays.
- **ERC-1271** (and EIP-6492 via the same viem path) so a smart-account wallet can SIWE. Session subject stays the checksummed contract or EOA address.
- **Paper-backup UI** for the wrap secondary KEK (`s3rch-wrap-v1:<base64url>`). Recovery, not login. Random 32-byte paper IKM (not a wallet-signature export). Shown once on wrap/export; paste unlocks.
- Light SociACL **Check see-grants** in the browser (`CHECK(see, object, accessor)` at `now`). Quiet `/feed` grant / revoke after SIWE on **held claims** and on **own native posts**. Grants are `IdentitySeeGrant` records on an in-memory / IndexedDB dest ACL **and** `MeshSeeGrant` rows on Gun `s3rch/acl`. Optional Social Light hop may factor Check; it never mints. Not login. Not share-into-mesh.
- **Live mesh delivery** of granted Gun-stored objects: holder put onto `s3rch/granted/<accessor>/{items|rooms|users}` (`v: 1`). Accessor **Granted** tab after SIWE. Privilege-down is immediate on dest ACL; first delivery can wait. URL fetches stay handoffs. Chat / presence are not grant-delivered. No `/api/deliver`.
- **Native s3r.ch posts** (`source: "s3rch"`) onto Mine (personal overlay) after a live SIWE cookie session. Same FeedItem / GunFeedNode shape. Default visibility is mine.
- **Rooms as Gun threads** (`gun.get('s3rch').get('rooms')`). Mine by default after `admitRoomNode`. Check see-grants on the room object. Explicit share of the **room node** onto the public rooms graph. Posts belong by tag (`room:{slug}`); sharing a room does not share unpublished Mine posts. Creating or posting in a room requires a live SIWE cookie session.
- **Live room chat** (`GunChatNode` on `s3rch/rooms/<id>/chat`). Admit via `admitChatNode` (Check). SIWE required to send. Mine-only chat stays on the overlay until that room node is shared. Shared public-room chat HAM-merges through the same-origin `/gun` seed peer. Unsigned visitors can **read** public-room chat; they cannot send. A see-grant is not delivery. Chat is not WebRTC.
- **Room presence** (`GunPresenceNode` on `s3rch/rooms/<id>/presence/<address>`). Admit via `admitPresenceNode` (Check). SIWE required to announce. Soft TTL (heartbeat ~25s, expire ~75s). Mine-only presence stays on the overlay until that room node is shared. Shared public-room presence HAM-merges through the same-origin `/gun` seed peer. Unsigned visitors can **see** presence on a public room; they cannot announce. A see-grant is not delivery. Presence is not WebRTC.
- **Public / Mine / Network / Granted** tabs. Public keeps snapshot hydrate + shared. Network is the live Gun mesh (`s3rch/items`, `s3rch/rooms` via `.map().on`) — not Mine overlay, not ingest, not the snapshot. Granted is the see-grant inbox (`s3rch/granted/<session>`) — not Public, not Network, not Discover. Tags-first then recency ranker (rooms reuse the same idea). No Popular / Novel. No search API.
- **Explicit share-into-mesh** on the holder's own native post: admit, then put the node onto `gun.get('s3rch').get('items')`. Same confirm pattern for an owned room node onto `s3rch/rooms`, and for the holder's user node / a selected held claim onto `s3rch/users/<wallet>`. A see-grant is not this. Room share ≠ post share. User-node share ≠ dumping every held claim.
- **Honest unshare** of a previously shared post, room, user node, or claim: own-only confirm, then a `v: 1` HAM tombstone (`unshared: 1`) on the same path, or a republish of the user node without that claim. Readers drop or hide when they observe the put. Observation can wait. Not a see-grant revoke. Room unshare does not delete Mine posts inside; public chat and presence then become local or empty for those readers. No `/api/unshare`.
- **Browser WebRTC** (`gun/lib/webrtc` after `gun/browser`, STUN ICE). Additive to the same-origin `/gun` seed peer. Signed-in allocate may add short-lived TURN `iceServers` from `/api/turn/allocate`. If ICE fails, seed / snapshot like today. STUN ≠ TURN. Chat and presence stay Gun subscriptions.
- **Signed-in browser pull** of the same documented public sources the lab seeder uses (Farcaster hub FIDs, ATProto AppView, RSS/Atom, ActivityPub actor outbox, Nostr kind 1 relay query, optional RSS3 GI) through `/api/ingest` **or** an allowlisted MV3 extension / `127.0.0.1` relay ([pull-relay.md](pull-relay.md)). Dest `admitFeedNode` before a `GunFeedNode` `v: 1` lands on Mine. Explicit share-into-mesh may HAM-merge onto `s3rch/items`. Direct browser-to-source still fails CORS in a naked tab. A pull is not a grant and is not an automatic public put.
- **Explicit Farcaster / ATProto outbound** on an owned native post (`Post to Farcaster` / `Post to Bluesky`). SIWE `POST /api/outbound`. Server-side `FARCASTER_FID` + `FARCASTER_SIGNER_KEY` and `ATPROTO_IDENTIFIER` + `ATPROTO_APP_PASSWORD` only — never `NEXT_PUBLIC_*`, never on Gun. Missing creds fail closed. Share / grant / pull do not post out. Not a second IdP.

## What this slice does not ship

- Passkey as primary login. Session subject stays the checksummed address.
- Writing the envelope, DEK, KEKs, SIWE signatures, or SEA `priv` / `epriv` to Gun for recovery.
- A paper-only wrap that drops the PRF KEK. Paper replaces the **secondary** IKM only.
- A Reown Cloud project id invented in this repo. Empty `NEXT_PUBLIC_WC_PROJECT_ID` stays injected + Smart Wallet (no WalletConnect).
- Coinbase CDP Embedded Wallet (`@coinbase/cdp-wagmi`), a CDP Project ID, email/phone magic link, Privy, Dynamic, Web3Auth, or Magic as the session. Those are email-login-as-IdP. Onramp is Smart Wallet then SIWE.
- Panopticon / Hypermesh Keycloak as an IdP. s3r.ch login stays EIP-4361 SIWE.
- ENS or Unstoppable as login, or dumping an ENS / Unstoppable / Farcaster / Lens / RSS3 claim onto the public Gun graph without an explicit share.
- A UD partner key in `NEXT_PUBLIC_*`, a browser call to `api.unstoppabledomains.com/resolve`, or Key Vault for `UNSTOPPABLE_API_KEY`.
- Farcaster SIWF, Lens OAuth, or RSS3 login. Indicators are held claims after SIWE, not session subjects.
- Importing `FyberLabs/SociACL` as a crate, NAPI, WASM, or npm package. Light Check is re-typed from the consume contract (`docs/s3rch-check.d.ts`).
- Friend-of-friend, Social Light hop UI, Elect / wills / Case C, or any verb beyond `see`. Hop may factor Check in TS; it is not a grant and has no public-page UI.
- NextAuth, Keycloak, or email magic link on this app. Email / phone confirm is a held claim after SIWE, not a session.
- Meetings, live streams, hop UI, Elect / wills / Case C. Live chat and presence over Gun subscriptions ship; they are not a TURN/WebRTC mesh. `gun/lib/webrtc` + STUN + signed-in allocate ships as a hop. Allocate is not a public mesh.
- ActivityPub / Nostr / RSS / RSS3 outbound. Farcaster + ATProto outbound **do** ship as an explicit SIWE action (not auto-bridge). Inbound pull for those networks stays a separate path. Native post ≠ bridging out.
- Popular / Novel columns, likes / views / engagement scores. Network **does** ship as the live mesh view (not a finished P2P mesh claim).
- Instant mesh-wide delete, or an Azure `/api/unshare`. Unshare is a client Gun tombstone / republish. Observation can wait. Check revoke stays dest ACL.
- Dumping user posts into the public seed / `GET /api/feed` snapshot / lab seeder by default.
- Changing seed Gun, Cloudflare, GitHub Actions, or `lib/auth.ts` seed helper (that file is `SEED_SECRET` only).

## Locks

| Lock | Why |
| --- | --- |
| Session key is the checksummed address | ENS, Unstoppable name, fname, Lens handle, RSS3 id, email, phone, KYC attestation, Keycloak `sub`, and SEA `pub` are never the session subject. EOA or ERC-1271 contract address only |
| Email / phone / KYC are held claims after SIWE | Confirm proves the claim to the holder. Private IndexedDB proof + overlay claim id. Public only after explicit share of that claim id. Live send / a real issuer fail soft as "not configured" when unset. Not AML. Not a passport product |
| Contract SIWE is mainnet ERC-1271 / EIP-6492 | Local Anvil is EOA-only. Do not send a local contract `eth_call` to mainnet |
| ENS is a held claim after SIWE | Reverse + forward must checksum-match. Unverified reverse is never shown |
| Unstoppable is a held claim after SIWE | Same bidirectional bar as ENS, on Polygon UNS. Never login. Empty `UNSTOPPABLE_API_KEY` is a quiet empty when on-chain misses, not a reason to drop ENS or other claims |
| Farcaster / Lens / RSS3 are held claims after SIWE | Same bidirectional bar as ENS. Unverified one-way lookups are never shown. A GI miss is a quiet empty RSS3 claim, not a reason to drop the others |
| Mesh identity is a **local Gun SEA P-256 pair**, not the Ethereum key | Different curves. Ethereum secp256k1 signs SIWE; SEA is for later mesh crypto |
| Never call `user.recall({ sessionStorage: true })` | Gun would store the plaintext SEA pair. Never `sessionStorage` for this kit. |
| Never put SIWE signatures, SEA `priv` / `epriv`, the envelope, DEK, KEKs on a Gun node | Session / device secrets stay in cookies and IndexedDB. Held claims go on `s3rch/users/<wallet>` only after explicit share. `fromGunUserNode` fails closed on those secret keys |
| Nonce lives in a **signed cookie**, not an in-memory `Map` | Azure App Service is multi-instance; Redis is not in this slice |
| OIDC is not primary login | Hypermesh portal can stay Keycloak; s3r.ch does not use Panopticon Keycloak as an IdP |
| Passkey WebAuthn PRF wrap is recovery | PRF is device proof for the Gun SEA pair. It does not become the session subject. Distinct from a Coinbase Smart Wallet passkey (onramp to an address, then SIWE) |
| Smart Wallet is an onramp, not an IdP | Coinbase Smart Wallet (passkey popup) creates or opens an address. Session is still EIP-4361 SIWE on the checksummed address. Not email login. Not Keycloak. Not `@coinbase/cdp-wagmi` |
| Paper backup is recovery | Same wrap slot as wallet secondary. Never login. Never persist the paper string, DEK, KEKs, or SEA `priv` / `epriv` in Gun, cookies, or `sessionStorage` |
| `lib/auth.ts` is seed authorize | User identity lives in `lib/identity/` |
| Check is grants, not login | Session subject stays the checksummed address. A live `IdentitySeeGrant` is not a session. hopcap 1. Revoke is immediate. URL 200 / ingest / seeder fetch is not `see` |
| Dest ACL is local + mesh | See-grants live in memory / origin IndexedDB (immediate privilege-down) and HAM-merge on Gun `s3rch/acl` as `MeshSeeGrant` (`stated` 1\|0). Cancel is owner-only and bumps `hamState`. Never write SIWE signatures, SEA `priv` / `epriv`, wrap envelopes, or paper strings onto public Gun. Hop never lands as a grant row |
| Outbound is explicit and session-gated | Farcaster hub submitMessage / ATProto PDS createRecord run only after SIWE on an owned native post. Server env only. Share ≠ outbound. Never put signer keys, app passwords, or PDS JWTs on Gun |

## Libraries

Pinned to current majors compatible with Next.js 16, React 19, and Node 24:

| Package | Role |
| --- | --- |
| `siwe` | Construct and parse EIP-4361 messages |
| `viem` | EOA `verifyMessage` (local ecrecover, no RPC). Contract verify via mainnet `publicClient.verifyMessage` (ERC-1271 + EIP-6492). Checksum via `getAddress`. Mainnet `getEnsName` + `getEnsAddress`. Polygon UNS `reverseNameOf` + `get("crypto.ETH.address")` |
| `wagmi` v3 | Injected always. `coinbaseWallet` Smart Wallet always (`smartWalletOnly`). `walletConnect` only when `NEXT_PUBLIC_WC_PROJECT_ID` is set. No RainbowKit, no ConnectKit, no `@coinbase/cdp-wagmi` |
| `@coinbase/wallet-sdk` | Peer for the wagmi Coinbase Smart Wallet connector. Ungated — no CDP / Reown project id |
| `@walletconnect/ethereum-provider` | Optional peer for the wagmi WalletConnect connector. Unused at runtime when the project id is empty |
| `@tanstack/react-query` | Required by wagmi |
| `jose` | Sign nonce and session cookies (HS256) |
| `gun` / `gun/sea` | Already a dependency. `createSeaPair()` calls `SEA.pair()` after SIWE. Persist in IndexedDB, not `recall()` |
| `@farcaster/core` | Server-only CastAdd encode for hub `submitMessage`. Never imported from client components |

No SimpleWebAuthn. The PRF helper uses native `navigator.credentials.create` / `get` with `extensions.prf`.

WalletConnect is **gated**. Do not invent a Reown project id in this repo or in CI. An empty `NEXT_PUBLIC_WC_PROJECT_ID` (the default) keeps the Docker image without WalletConnect; injected + Smart Wallet still ship. Smart Wallet is **ungated** and does not use a CDP Project ID.

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
| `lib/identity/wagmi.ts` | Injected + Coinbase Smart Wallet always; `walletConnect` only when `walletConnectProjectId()` is non-null |
| `lib/identity/ens.ts` | Mainnet ENS reverse + forward held claim. Mockable public-client surface |
| `lib/identity/unstoppable.ts` | Polygon UNS Unstoppable reverse + forward held claim. Mockable client (on-chain + optional Resolution fallback) |
| `lib/identity/farcaster-claim.ts` | Hubble custody reverse + FID registry forward. Display fname or `fid:N` |
| `lib/identity/lens-claim.ts` | Public Lens GraphQL owned-account reverse + owner forward |
| `lib/identity/rss3-claim.ts` | Optional GI overlay reverse + owner forward. Quiet label, not a feed |
| `lib/identity/indicators.ts` | Session-gated Farcaster / Lens / RSS3 in one trip. Isolates GI misses |
| `lib/identity/check.ts` | Consume-contract Check: `checkSee`, `checkSeeGrant`, `applySeeGrant`, `cancelSee`, `admitFeedNode`, `admitRoomNode`, `admitChatNode`, `admitPresenceNode`, `admitUserNode`, `acceptHint`, `acceptHop`, `decodeHop`, souls (`itemSoul`, `roomSoul`, `chatSoul`, `presenceSoul`, `userSoul`, `grantedSoul`, `aclSoul`, `grantSoul`) |
| `lib/identity/mesh-acl.ts` | Gun `s3rch/acl` `MeshSeeGrant` put / read / HAM-merge. Bridges lab IndexedDB dest ACL. Hop never mints |
| `lib/grant-delivery.ts` | Holder prepare + accessor accept for grant-inbox envelopes (`v: 1`). Native posts, rooms, user/claim only. Tombstone retract. Does not write Public |
| `lib/users.ts` | User node builder, GunUserNode csv indicators, assemble/link held claims onto the Mine overlay after SIWE lookups, admit-before-overlay / admit-before-share / admit-before-unshare of the user node or an individual claim. Mine overlay until explicit put. No `/api/users` |
| `lib/identity/user-overlay.ts` | Origin IndexedDB / memory store for the Mine overlay `GunUserNode`. Same wire shape as `s3rch/users/<wallet>`. Fail closed on secrets. Not a public put |
| `lib/unshare.ts` | HAM tombstone helpers (`unshared: 1`, `v: 1`), drop-by-id, honest copy. Fail closed for unknown `v` / unknown `unshared` |
| `lib/identity/see-acl.ts` | Lab dest ACL (memory + IndexedDB). `IdentitySeeGrant` records only |
| `lib/identity/held-claims.ts` | Claim ids linked from the user node (`ens:name.eth`, `unstoppable:brad.x`, `email:…`, `phone:…`, `kyc:<issuer>:…`). Lookup settle vs pending. Not `s3rch/users/{wallet}/claims/…` |
| `lib/identity/confirm.ts` | Session-gated email / phone start + verify. Fixture code or env-gated `CONFIRM_SEND_URL`. Challenge cookie hashes only. Not login. Not a Gun put |
| `lib/identity/confirm-proof.ts` | Origin IndexedDB / memory store for private confirm proofs. Fail closed on secrets / OTP leftovers. Not a public put |
| `lib/identity/kyc.ts` | KYC issuer adapter + fixture stub (`kyc:fixture:held`). `KYC_ISSUER_URL` swaps in a real HTTP issuer; unset is honest "not configured" for non-fixture ids |
| `components/useMineUserOverlay.ts` | After SIWE: hydrate previous overlay + assemble/link settled lookups. Not a public put |
| `components/useHeldConfirms.ts` | After SIWE: hydrate private email / phone / KYC proofs into overlay lookups |
| `components/HeldConfirmControls.tsx` | Signed-in email / phone confirm + Hold attestation. Visitor verbs. Not configured when unset. Does not publish |
| `components/UserNodeControls.tsx` | Signed-in publish / unshare user node and share / unshare claim (confirm + admit + put). Held vs Public on linked overlay claims. Copy stays visitor verbs |
| `components/GunPeerProvider.tsx` | Thin `/feed` Gun handle so IdentityBar can put a user node on the same browser Gun FeedStream constructed |
| `lib/compose.ts` | Native post builder + admit-before-overlay / admit-before-share / admit-before-unshare. Empty body rejected. Does not call OutboundAdapter |
| `lib/outbound.ts` | UI-safe parse / own-native gate / draft. Not hub signing |
| `lib/outbound-adapters.ts` | Server factory: Farcaster + ATProto live; ActivityPub / Nostr unimplemented |
| `lib/farcaster-outbound.ts` | Hub `submitMessage` CastAdd. `FARCASTER_FID` + `FARCASTER_SIGNER_KEY`. Never `NEXT_PUBLIC_*` |
| `lib/atproto-outbound.ts` | PDS `createSession` + `createRecord`. `ATPROTO_IDENTIFIER` + `ATPROTO_APP_PASSWORD`. JWT not stored |
| `app/api/outbound` | SIWE `GET` status + `POST` `{ network, item }`. Own native only. 401 without session |
| `components/OutboundPostControls.tsx` | Short Mine verbs: Post to Farcaster / Post to Bluesky. Confirm, then POST. No protocol essay |
| `lib/rooms.ts` | Room builder, GunRoomNode csv tags, admit-before-overlay / admit-before-share / admit-before-unshare of the room node, `roomTag`, `roomsForTab`, `itemsInRoom`, `rankRooms` |
| `lib/chat.ts` | Room chat builder, GunChatNode, admit-before-overlay / admit-before-put on the room chat path, Mine overlay until the room is on `s3rch/rooms` |
| `lib/presence.ts` | Room presence builder, GunPresenceNode, admit-before-overlay / admit-before-put on the room presence path, soft TTL, Mine overlay until the room is on `s3rch/rooms` |
| `lib/gun-webrtc.ts` | Default STUN ICE (`stun:stun.l.google.com:19302`), RTC constructor guard, `gun/lib/webrtc` import. STUN ≠ TURN. No live RTCPeerConnection in CI |
| `lib/turn-allocate.ts` | Server hop to Panopticon allocate. `PANOPTICON_TURN_*` server env. Session-gated. Fail soft |
| `lib/turn-ice.ts` | Browser `/api/turn/allocate` fetch, STUN fallback, re-allocate before `expiresAt` |
| `app/api/turn/allocate` | `GET`/`POST` — SIWE cookie, then hop. 401 unsigned; 503 empty env / hop fail |
| `lib/feed-rank.ts` | Tags-first any-match filter, then recency. No engagement |
| `lib/feed-discover.ts` | Client Discover corpus (Public seed + shared rooms + live Network mesh). Inventory tag counts, `?tag=` parse, owner snippet. Not search / Popular / Mine |
| `lib/feed-tabs.ts` | Public = seed; Mine = overlay; Network = live shared Gun mesh; Granted = grant inbox (not snapshot, not overlay, not Public) |
| `app/api/identity/nonce` | `GET` — issue nonce cookie, return `{ nonce }` |
| `app/api/identity/verify` | `POST` `{ message, signature }` — verify SIWE, set session |
| `app/api/identity/session` | `GET` — current `{ address, chainId }` or 401 |
| `app/api/identity/ens` | `GET ?address=` — session-gated ENS claim for the session address only |
| `app/api/identity/unstoppable` | `GET ?address=` — session-gated Unstoppable claim for the session address only |
| `app/api/identity/indicators` | `GET ?address=` — session-gated Farcaster / Lens / RSS3 claims for the session address only |
| `app/api/identity/confirm/start` | `POST` `{ kind, target }` — session-gated email / phone confirm start. Fixture or env send. Does not write Gun |
| `app/api/identity/confirm/verify` | `POST` `{ kind, target, code }` — session-gated verify. Returns claim id. Proof is client IndexedDB |
| `app/api/identity/kyc` | `POST` `{ issuer?, subject? }` — session-gated KYC attestation. Fixture unless `KYC_ISSUER_URL` |
| `app/api/identity/logout` | `POST` — clear identity cookies |
| `components/IdentityBar.tsx` | Quiet `/feed` connect + Passkey wallet (Smart Wallet onramp) + optional WalletConnect + SIWE + mesh key + wrap/unlock + paper backup + held-claim lookups that assemble the Mine overlay + email / phone confirm + Hold attestation + publish user node / share claim + see-grant / revoke + sign out |
| `components/SeeGrantControls.tsx` | Signed-in grant see / revoke of a Gun-linked held claim from the Mine overlay. Dest ACL + grant-inbox put. Public copy is a short UX hint. No hop UI |
| `components/ComposeForm.tsx` | Signed-in native compose onto Mine. Optional `roomId` adds the room membership tag. Signed-out: one-line SIWE hint, not a second IdP |
| `components/PostSeeGrantControls.tsx` | Grant see / revoke on an owned native post (`claimId` = post id / item soul). Dest ACL + grant-inbox put |
| `components/DiscoverPanel.tsx` | Discover on Public / Network: tags already on seed + shared rooms + live mesh, inventory counts, matching shared rooms, quiet shared-user provenance. Same ranker. Not search / Popular / Mine. Public copy is a short UX hint |
| `components/RoomsList.tsx` | Quiet Mine / Public / Network rooms list + New room (SIWE, Mine only). Network rooms = shared `s3rch/rooms`. Public / Network rows may show a short owner snippet (provenance). Not a `/rooms` landing. Public copy is a short UX hint |
| `components/RoomChat.tsx` | Live chat pane on an open room. Gun `.map().on` / put when the room is on `s3rch/rooms`; overlay while Mine-only. SIWE to send. Unsigned read on public rooms. Public copy is a short UX hint |
| `components/RoomPresence.tsx` | Quiet who-is-here line on an open room. Gun `.map().on` / put when the room is on `s3rch/rooms`; overlay while Mine-only. SIWE to announce. Unsigned read on public rooms |
| `components/RoomSeeGrantControls.tsx` | Grant see / revoke on an owned Mine room (`claimId` = room id / room soul). Dest ACL + grant-inbox put. Public copy is a short UX hint |
| `components/SeeAclProvider.tsx` | Shared dest ACL + mesh HAM index for IdentityBar claims and feed post objects |
| `components/MeshAclSync.tsx` | Subscribe to Gun `s3rch/acl` and merge `MeshSeeGrant` into dest ACL |

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

IdentityBar caches the claim in component state for the current session (no Redis), then assembles it onto the Mine overlay as `ens:name.eth`. Session chrome shows the name as **Held.** until an explicit share (**Public.**). `vitalik.eth` ↔ `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` still reverse+forward as of 2026-09-01 and is the documented format example — not a screenshot subject for Anvil.

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

IdentityBar fetches after the SIWE session (separate from ENS / indicators) and caches the claim in component state (no Redis), then links it on the Mine overlay as `unstoppable:name`. Session chrome shows the name as **Held.** until an explicit share. Tests use a dummy `0xCcCC…cccC`. `brad.x` ↔ `0x8aaD44321A86b170879d7A244c1e8d360c99DdA8` still reverse+forwards on Polygon ProxyReader as of 2026-09-02 and is the documented format example — not a screenshot subject. The UD docs wallet `0x88bc…` still reverse-resolves `jim-unstoppable.x` but its `crypto.ETH.address` does **not** checksum-match, so it is not a fixture.

### Operator path (`UNSTOPPABLE_API_KEY`, optional)

1. Create a Resolution Service API key from the Unstoppable partner / API panel (backend key, not a browser key).
2. Set `UNSTOPPABLE_API_KEY` on the Azure App Service **runtime** env (not `NEXT_PUBLIC_*`, not Docker build-arg). Local: `.env.local`.

### Operator path (Farcaster / ATProto outbound)

Server-only. Not a second IdP. SIWE still gates who may press **Post to Farcaster** / **Post to Bluesky**.

1. Farcaster: set `FARCASTER_FID` and `FARCASTER_SIGNER_KEY` (32-byte ed25519 hex for a signer already authorized on that FID). Optional `FARCASTER_HUB_AUTH=user:pass` if the hub uses `--rpc-auth`. `FARCASTER_HUB_BASE` is the same override as inbound pull.
2. Bluesky: set `ATPROTO_IDENTIFIER` and `ATPROTO_APP_PASSWORD`. Optional `ATPROTO_PDS_BASE` (default `https://bsky.social`). Do not use `ATPROTO_APPVIEW_BASE` for writes.
3. Never `NEXT_PUBLIC_*`. Never write these values, SIWE signatures, or the PDS access JWT onto Gun. Empty env fails closed with a short UI reason.
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

`GET /api/identity/indicators?address=` is session-gated. The query address, when present, must match the session subject. The route does not become an open Farcaster / Lens / RSS3 proxy. ENS stays on `GET /api/identity/ens` and Unstoppable stays on `GET /api/identity/unstoppable` (unchanged verification rules). IdentityBar fetches ENS, Unstoppable, and this one indicators route after session — not three extra uncoordinated indicator trips — caches results in component state (no Redis), and links verified names onto the Mine overlay GunUserNode.

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

Signed-out: **Connect wallet** (injected). A quiet **Passkey wallet** control opens Coinbase Smart Wallet (`smartWalletOnly`) so someone without an extension can get an address. When `NEXT_PUBLIC_WC_PROJECT_ID` is set at build time, a quiet **WalletConnect** control appears. Sign in with Ethereum still runs after a session address exists. Passkey wallet is an onramp, not a separate identity provider. Do not dump Coinbase branding as a new login product. The Smart Wallet passkey is not the WebAuthn PRF wrap of the Gun SEA pair.

After signed-in + mesh key present:

- `Wrap with passkey` when the record is plaintext and PRF is not known-unavailable
- Optional `also show a paper backup` on wrap: PRF + random paper secondary (not wallet)
- `Unlock mesh key` (PRF, then wallet secondary when present)
- Paste field + `Unlock with paper` when wrapped and locked; clear the paste after success
- `Export paper backup` when wrapped and PRF is not known-unavailable: re-wrap with a new paper IKM, show `s3rch-wrap-v1:` once (copyable), then the user keeps it
- Degrade copy when PRF is missing; paper unlock still works
- After SIWE: verified claims assemble onto the Mine overlay. Session chrome shows **Held.** / **Public.** — not `ENS claim:` essays. Empty Unstoppable does not drop the others
- Do not dump `priv` / `epriv`, the paper string as a standing `/feed` hero line, or invalid-paste dumps
- After SIWE: quiet **Grant see** / **Revoke** for a Gun-linked held claim (wallet / ENS / Unstoppable / …) to another checksummed address and a time window. Copy: this is a grant, not login. No hop UI

## Local SEA mesh key (after SIWE)

After `POST /api/identity/verify` succeeds, the client:

1. Looks up this checksummed address in origin IndexedDB (`s3rch-identity` / `mesh-keys`).
2. **Reuses** the stored pair + wallet-signed link when present (plaintext or wrapped; does not mint a new pair every sign-in).
3. Otherwise calls `createSeaPair()` (`gun/sea` `SEA.pair()`, P-256, not the Ethereum key), asks the connected wallet to sign a short domain-bound statement that this `pub` belongs to this address, and saves `{ address, seaPub, seaPair, walletSignature, signedPayload }` in IndexedDB.

Legacy lab records may still be **plaintext in IndexedDB**. PRF wrap replaces that `seaPair` field when the user wraps.

Locks that stay:

- Never `sessionStorage`.
- Never `user.recall({ sessionStorage: true })`.
- Never write SIWE signatures, SEA `priv` / `epriv`, the envelope, DEK, KEKs, the paper backup string, or the wallet-signed link onto the public Gun graph. Held claims go on the user node only after explicit share.
- Session subject remains the checksummed address. Paper backup is recovery, not login.

## WalletConnect (gated connector, not an IdP)

This slice ships WalletConnect **gated** on `NEXT_PUBLIC_WC_PROJECT_ID`. Injected stays the default Connect wallet control. If the env is unset or empty, Connect wallet still shows "No injected wallet found." when no extension is present; **Passkey wallet** (Smart Wallet) remains available. If it is set (non-empty) at **build time**, IdentityBar shows a quiet **WalletConnect** control. Sign-in is still SIWE after a wagmi session address exists (injected, Smart Wallet, or WalletConnect). Session subject stays the checksummed address. No Keycloak, no RainbowKit, no ConnectKit.

Next.js inlines `NEXT_PUBLIC_*` at `next build`. s3r.ch builds inside Docker (`Dockerfile` builder stage). App Service **runtime** env will not inject this into the client bundle. The Dockerfile takes `ARG NEXT_PUBLIC_WC_PROJECT_ID` and sets `ENV` **before** `npm run build`. Deploy passes `build-args: NEXT_PUBLIC_WC_PROJECT_ID=${{ vars.NEXT_PUBLIC_WC_PROJECT_ID }}` (GitHub **variable**, not secret — this id is public, same class as `SEED_URL`). A missing variable must not fail the build (empty ARG → injected-only).

Local: copy `.env.example` to `.env.local`. `next dev` reads `.env.local`. Do not commit a real id.

### Operator path (do not invent an id)

1. Create a Reown Cloud project at https://cloud.reown.com named `s3r.ch`.
2. Allow `https://s3r.ch` and `http://localhost:3000`.
3. Copy the Project ID.
4. Put it in FyberLabs/infra `config/infra.yaml` `apps.s3rch_wc_project_id` (public, same class as `stripe_publishable_key`). Sync with `python3 scripts/sync-github-secrets.py --repo-only --apply` so GitHub variable `NEXT_PUBLIC_WC_PROJECT_ID` lands on FyberLabs/s3r.ch.
5. Local: `.env.local`. Prod: redeploy so Docker rebuilds with the build-arg.

A sibling infra PR will add the variable mapping. Until that id exists, leave the env empty.

## Coinbase Smart Wallet onramp (not an IdP)

People not in crypto yet still need an address before they can SIWE. This slice ships wagmi v3 `coinbaseWallet` from `wagmi/connectors` with Smart Wallet only:

```ts
coinbaseWallet({
  appName: "s3r.ch",
  appLogoUrl: "https://s3r.ch/favicon.ico",
  preference: { options: "smartWalletOnly" },
})
```

That popup is a **passkey smart account**. After connect, IdentityBar **Sign in with Ethereum** is unchanged. Mainnet ERC-1271 already verifies contract wallets. Session subject stays the checksummed address.

This is **not** a second identity provider:

- Login stays EIP-4361 SIWE. No email/phone magic link. No Keycloak.
- Do **not** add Coinbase CDP Embedded Wallet (`@coinbase/cdp-wagmi`). That path is email-login-as-IdP. Do **not** invent a CDP Project ID.
- No RainbowKit, ConnectKit, Privy, Dynamic, Web3Auth, or Magic as the session.
- Smart Wallet is **ungated** (no project id). WalletConnect stays gated on `NEXT_PUBLIC_WC_PROJECT_ID`.
- The Coinbase Smart Wallet **passkey** is not the WebAuthn **PRF wrap** of the local Gun SEA pair. PRF wrap stays recovery.

Quiet `/feed` copy: Passkey wallet creates or opens a Coinbase Smart Wallet. Sign-in is still SIWE. It is not a separate identity provider. Do not dump Coinbase branding as a new login product.

## Light Check see-grants (grants, not login)

After SIWE, the holder can grant `see` of a held claim (wallet, ENS, Unstoppable, Farcaster, Lens, RSS3, email, phone, KYC attestation), **an owned native post**, **an owned room**, or **their user node** to another checksummed address for a time window, and revoke immediately. A live grant also **delivers** that Gun-stored object onto `s3rch/granted/<accessor>` (Granted tab). Chat messages and presence heartbeats that live in Gun are dest-ACL objects (`admitChatNode`, `admitPresenceNode`); a see-grant on them is not delivery and not a public put. Session subject stays the checksummed address. Copy: **this is a grant, not login, and not share-into-mesh.** First delivery can wait on the mesh. Revoke is immediate on dest ACL. Holding a claim is not publishing it.

Source of truth: [s3rch-check.md](s3rch-check.md) / [s3rch-check.d.ts](s3rch-check.d.ts), matching FyberLabs/SociACL `crates/sociacl-gun` consume contract. Do not import that crate.

`CHECK(see, object, accessor)` at `now`:

- Owner sees their object.
- Else a live `IdentitySeeGrant` / `MeshSeeGrant` must name the pair and `now ∈ [from, until)` (`until` exclusive).
- Hint never sets `allowed`. Hop missing does not fail. Hop alone never allows. hopcap **1** — do not walk friend edges.
- `meta`, dest ACL souls, and `UrlLeaf` fail closed. A URL 200 is not `see`.
- `admitFeedNode` re-authorizes at dest before `put` into `items`.
- `admitRoomNode` re-authorizes at dest before `put` into `rooms`.
- `admitChatNode` re-authorizes at dest before overlay register or `put` onto a room `chat` set.
- `admitPresenceNode` re-authorizes at dest before overlay register or `put` onto a room `presence` set. Owner must be the address on the node.
- `admitUserNode` re-authorizes at dest before overlay register or `put` onto `s3rch/users/<wallet>`. Owner must be the wallet on the node. Linked indicators are claim ids.
- Privilege-down (`cancelSee`) is immediate.

Dest ACL is lab-local (memory / IndexedDB) for immediate privilege-down, plus Gun `s3rch/acl` `MeshSeeGrant` so peers evaluate the same Check after HAM-merge. Grants are `IdentitySeeGrant` / `MeshSeeGrant` records only. Public mesh vs mine still applies: a grant is not share-into-mesh and is not written onto `s3rch/items|rooms|users`. Delivery is a separate holder put onto `s3rch/granted/<accessor>`. Share-into-mesh is a separate confirm + `items.put` of an already-admitted GunFeedNode, `rooms.put` of an already-admitted GunRoomNode, or `users.put` of an already-admitted GunUserNode (full node or a selected claim). Unshare is a separate confirm + tombstone / republish put on those same public paths. It does not call `cancelSee`. Observation can wait. Delivery must not resurrect those unshare tombstones. Grant ≠ share ≠ delivery ≠ unshare.

Claim object id is the claim id, linked from the user node (`ens:name.eth`, `email:…`, `phone:…`, `kyc:<issuer>:…`). Do not invent `s3rch/users/{wallet}/claims/…`.

Quiet `/feed` IdentityBar: grant see + revoke after SIWE on held claims. Publish / unshare user node and share / unshare claim after SIWE (confirm + admit + put). Quiet Grant see / Revoke on own Mine native posts and own Mine rooms. Unshare is on the Mine share controls, not on the grant row. No hop UI. No Elect / wills / Case C. Social Light hop may factor Check in TS; it cannot mint a grant. Compose, new room, sending chat, announcing presence, writing a user node, and pulling allowed lab sources require a live SIWE cookie session. Login stays EIP-4361. No email login, no Keycloak, no second IdP.

## Follow-ups

- Operator: App Service WebSockets + HTTP/2 so the already-wired same-origin `/gun` peer can stay up (Cloudflare + Azure ARR can still drop the socket; snapshot stays on Public). `gun/lib/webrtc` + STUN, session-gated path A allocate consume, the Network tab, the Granted tab, the Gun user node, unshare, live mesh delivery, and signed-in browser pull (Mine until share) already ship. Empty `PANOPTICON_TURN_*` stays STUN. No TURN secrets on Gun. Durable graph stays requirements-only: [durable-graph-and-turn.md](durable-graph-and-turn.md). Product end-state is Panopticon. Optional time-boxed infra coturn only with the same URI contract and DNS/config cutover — not a second control plane, not WG/Tailscale for browsers. Still later: meetings/streams. Room presence already ships. Google STUN ≠ TURN. Long-term low/no server footprint, TURN-class relays, Panopticon-hosted needed services, oracles/validators, versioned Gun `v`, and later crypto (or optional fiat) payments: [ARCHITECTURE.md — Steering locks (2026-09-02)](ARCHITECTURE.md#steering-locks-2026-09-02). Do not grow s3r.ch Azure into that service in this PR.
- SNS / Solana names (not this slice; ENS remains primary mainnet reverse+forward. Unstoppable is a held claim after SIWE, not login).
- Live vendor send / KYC issuer after SIWE (not as login). Confirm already ships as a private held claim. Mesh-wide Check + hop factor ship; hop UI and friend-of-friend do not. Do not import `FyberLabs/SociACL`.
- Azure Key Vault for `IDENTITY_SESSION_SECRET` and later `UNSTOPPABLE_API_KEY` (still operator / Azure in this slice).
- Contract verify on chains other than mainnet (this slice's 1271 RPC allowlist is mainnet only).

This slice ships an Unstoppable held claim after SIWE (Polygon on-chain reverse+forward; optional server-only Resolution key), paper-backup UI for the wrap secondary KEK, ERC-1271 (and EIP-6492 via the same viem `verifyMessage` client), WalletConnect gated on `NEXT_PUBLIC_WC_PROJECT_ID`, Coinbase Smart Wallet as an **onramp then SIWE** (not email login, not Keycloak, not `@coinbase/cdp-wagmi`), light SociACL Check see-grants (consume contract in [s3rch-check.md](s3rch-check.md)), live mesh delivery of granted Gun-stored objects (Granted tab; not Public), a Gun user node keyed by the SIWE address (Mine until explicit share of the node or of a held claim), signed-in browser pull of the same documented public sources the seeder uses (same-origin `/api/ingest` or allowlisted extension/relay; Mine until share; CORS still blocks direct browser-to-source in a naked tab), native s3r.ch posts (mine by default), rooms as Gun threads (Mine by default, Check on rooms, explicit share of the room node, tags discovery), live room chat and presence over Gun subscriptions (Mine overlay until the room is shared; SIWE to send or announce), Public / Mine / Network / Granted tabs, a Discover browse of tags already on Public and the live Network mesh plus shared-user provenance (not Mine overlay, not Granted, not search, not Popular/Novel), Check on those post objects, explicit share-into-mesh, tags-first recency ranking, and `gun/lib/webrtc` with STUN ICE plus a session-gated allocate hop. Check is grants, not login. A grant is not share-into-mesh. Delivery is the grant inbox, not a public put. Holding a claim is not publishing it. Room share ≠ post share. Chat in a visible room is the live thread; it is not dumping Mine posts. Presence is who is in that room now; it is not WebRTC. Network is the live shared mesh view via seed peer / WebRTC; it is not a finished P2P mesh. STUN is not TURN. Unstoppable is never login. s3r.ch does not use Panopticon Keycloak as an IdP. Unshare retracts a prior mesh put when peers observe the tombstone; it is not instant everywhere and not a see-grant revoke. Delivery does not write those public paths. Allocate is not a public mesh. Email / phone / KYC stay private held claims until the holder shares that claim id from the user node.

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
