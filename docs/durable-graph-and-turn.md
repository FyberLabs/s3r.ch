# Durable Gun graph and TURN (2026-09-09)

Durable graph stays requirements-only. **Path A consume is wired:** session-gated `POST /api/turn/allocate` hops to Panopticon `POST /api/v1/turn/allocate` and may set Gun `opt.rtc.iceServers`. This file does **not** deploy coturn, mount a disk, or put the long-lived TURN secret in the browser.

Parent: [ARCHITECTURE.md](ARCHITECTURE.md). Identity / Check locks stay in [identity.md](identity.md) and [s3rch-check.md](s3rch-check.md). Fyber-wide service lock: [FyberLabs/hypermesh-docs `open-services.md`](https://github.com/FyberLabs/hypermesh-docs/blob/main/open-services.md) (2026-09-02). Infra facts: [FyberLabs/infra `docs/PLATFORM.md`](https://github.com/FyberLabs/infra/blob/main/docs/PLATFORM.md) and [`terraform/s3rch/README.md`](https://github.com/FyberLabs/infra/blob/main/terraform/s3rch/README.md).

Chris can decide **Panopticon vs interim infra** from this file. The 2026-09-02 lock is not amended here.

## What this is / is not

This is an instrument-honest requirements note for two missing pieces:

1. **Durable graph** — what should still exist after an App Service recycle.
2. **TURN** — when STUN cannot punch NAT, and where that relay may live.

It is **not** a finished P2P mesh claim. `gun/lib/webrtc` is STUN by default; signed-in allocate may add short-lived `turn:` / `turns:`. Browser Gun uses `localStorage: false`. The seed peer is a cache. Chat and presence are Gun subscriptions, not WebRTC. Meetings / streams are later.

Out of this file: implementing coturn, Terraform apply, meetings/streams UI, putting the long-lived TURN secret on Gun or `NEXT_PUBLIC_*`, Odoo/GitLab restyle.

## Steering locks (stay put)

From [ARCHITECTURE.md — Steering locks (2026-09-02)](ARCHITECTURE.md#steering-locks-2026-09-02) and `open-services.md`:

| Lock | Meaning here |
| --- | --- |
| Server footprint low or none | Azure App Service is seed / bootstrap, **not** a product DB or chat server. Ephemeral container disk is not the archive. End-state servers are TURN-class relays. |
| Open protocol, client P2P | Live state is Gun HAM-merge in clients, not a farm of origin servers. |
| Oracles / validators in the browser when possible | A service we still run should look like a relay / validator, not a privileged social backend. |
| Needed services live in **Panopticon** | Seed, TURN, paid access, oracles we cannot do in-browser: open product network, public APIs, market of equivalents. Do not grow s3r.ch Azure into that service. Do not invent a second control plane. |
| STUN ≠ TURN | Google `stun.l.google.com:19302` is STUN. It is not free TURN. No TURN on App Service. |

Chris asked whether TURN can deploy **in FyberLabs/infra as a service independent of Panopticon**. Fyber Research Bot (infra/Azure, docs-phase) agrees the lock stands: required client-mesh services belong in **Panopticon** (open/public, market-equivalent OK). Azure is not the Gun datastore. An interim coturn is sane **only** under the conditions in **Path B is legal only if** below.

| Path | What it is | Lock |
| --- | --- | --- |
| **A** | Panopticon-hosted TURN product (open API, market of equivalents) | Matches the lock. **Recommended end-state.** |
| **B** | Optional, **time-boxed** FyberLabs/infra coturn that already implements the **same TURN/URI contract** as A. Graduation is DNS/config cutover, not a second control plane. | Lock **stays**. Allowed only if every B condition holds. |
| **C** | Fully independent infra-only forever | Conflicts with the lock unless `open-services.md` is amended. This file does not amend it. |

This file recommends **A as the product end-state**, plus **optional time-boxed B** for the lab if Chris wants a relay before the Panopticon product exists. Path C is listed so the tension is visible. Choosing C is a lock change — do it in hypermesh-docs, not by silence here.

### Path B is legal only if

All of these are true before anyone applies Terraform. Otherwise wait for A (lab stays STUN + `/gun`).

1. **Same TURN/URI contract as the eventual Panopticon service.** Allocate response, ICE `urls` / username / credential / TTL shape, and hostname role (`turn.…`) are the contract in [Open-market shape](#open-market-shape-panopticon-path-a--the-uri-contract). Interim mint and product mint are interchangeable. Clients do not learn a second API.
2. **Time-boxed.** The infra VM is labeled interim (config comment + this file). It is not “the Fyber TURN product.”
3. **No product data on it.** TURN is relay-class only: allocations, auth HMAC, logs. No Gun radisk, no snapshot, no rooms, no grant inbox, no SIWE/SEA material. The Gun seeder stays on App Service (or a later Panopticon seed). Separate process, **separate host**.
4. **Graduation is DNS/config cutover**, not a permanent second control plane. Flip the allocate base URL / ICE hostname (or CNAME) to the Panopticon operator. Do not keep a parallel mint on s3r.ch Azure.

Do **not** invent cottage WireGuard or Tailscale as the relay path for s3r.ch **browser** clients. Tailscale stays the **admin** path (SSH to the VM), same as GitLab / Odoo / `vm-pano-test`. Hypermesh `wg.test.hyperme.sh` is a different product (host tunnel). Browsers speak STUN/TURN/ICE, not a Fyber WG overlay.

## Recommendation (lab vs product)

| | Near-term lab | Product end-state |
| --- | --- | --- |
| **Durable graph** | Keep App Service a seed. Survive recycle of the **public seeder cache** with Azure Blob (the existing `snapshot.json` shape). Do **not** mount radisk as a Mastodon-class origin. Shared rooms / users / granted / chat stay mesh + next seed. Optional later: browser graph persist (not SEA `recall`). | The mesh is the archive. Any durable seed is a Panopticon open relay others can run. App Service stays bootstrap. Azure is not the Gun datastore. |
| **TURN** | **Optional path B** — only if the four conditions above hold. One small dedicated Linux VM (start **B2s / B2ms**, **East US 2**), public TURN, identical allocate/ICE contract to A. | **Path A.** Panopticon product network with that same public credential API. Cut over DNS/config. The lab VM is retired or becomes one operator behind the façade. |

Graduation from B → A is **cutover of DNS/config**, named below. Until then the lock is not rewritten.

---

## Durable graph

### What dies on an App Service recycle today

Honest inventory. Do not treat `/app/data` as the archive ([ARCHITECTURE.md — Honest gates](ARCHITECTURE.md#honest-gates)).

| Store | Where | Survives recycle? | What it holds |
| --- | --- | --- | --- |
| radisk | Container disk (`GUN_FILE`, default `/app/data/radata` via `gun-preload.cjs`) | **No.** New container = empty directory | Whatever the process HAM-merged while it was up: seeder items, plus any client puts that reached `/gun` (shared items / rooms / users / granted / public chat / presence) |
| JSON snapshot | Container disk (`GUN_SNAPSHOT`, default `/app/data/snapshot.json`) | **No.** `loadSnapshot` fails closed to empty | **Seeder Public items only** (`putItems` / `setSeedMeta` in `lib/gun-server.ts`). Not rooms, chat, presence, users, or the grant inbox |
| In-memory index | Process (`__s3rchStore`) | **No** | Same as the snapshot |
| Browser Gun | `/feed` constructs Gun with `localStorage: false` | **No** across tab close / refresh | Live `.map().on` rows only while the page is up |
| Dest ACL / SEA wrap | Origin IndexedDB | **Yes** (that origin, that browser) | See-grants and the local SEA pair. Not the public graph. Not TURN secrets |
| Next weekday seed | GitHub Action → `POST /api/seed` | Rebuilds **seeder Public** only | Farcaster / ATProto / RSS / optional GI. Does not restore shared native posts, rooms, users, granted, chat, or presence |

So after recycle, today:

- Public can refill from the next seed (or stay empty until then).
- Network / Granted / shared rooms / public chat / presence are empty unless a still-open browser tab still holds them in memory **and** can reach a live `/gun` or a WebRTC peer.
- Unshare tombstones that only lived on the seed radisk are gone. A later re-share or a stale peer can look like resurrection until HAM merges again. Delivery must still not write public paths.

That is a cache, not an archive. The copy on `/feed` already says so.

### Requirements

What a durable graph must do without growing App Service into Mastodon:

1. **Public seeder cache** may survive recycle so first paint is not empty. That is still a bootstrap, not the product DB.
2. **HAM-merge stays the merge.** Same `v: 1` nodes. Unknown `v` / unknown `unshared` fail closed. Do not invent a REST restore API that bypasses admit.
3. **Unshare tombstones travel with the node.** If a durable seed keeps a path, it must keep `{ id, unshared: 1, v: 1 }` on that path. Restoring an old snapshot over a newer tombstone is a bug. Re-share still puts `unshared: null`.
4. **Grant inbox** (`s3rch/granted/<accessor>/…`) is mesh state. Privilege-down stays immediate on the dest ACL (IndexedDB). Inbox retract (`retracted: 1`) can wait. A durable seed may cache inbox rows; it must not mint `see`, must not write Public / Network, and must not resurrect an `unshared: 1` public row.
5. **Chat / presence** are live. Soft TTL presence (~75s) should **not** be archived. Chat on a shared room may HAM-merge across peers; a durable seed may hold it as cache, not as a hosted transcript product.
6. **Secrets stay off Gun.** No SIWE signatures, SEA `priv` / `epriv`, wrap envelopes, paper strings, or TURN shared secrets on any node. `fromGun*` already fails closed on those keys.
7. **Backup / restore** is “copy the versioned Gun nodes (and tombstones), then HAM-merge.” It is not Azure Blob versioning of arbitrary JSON as a second schema, and not `/api/unshare` / `/api/deliver`.
8. **Mine overlay** stays local (memory / that browser). Do not persist other people’s Mine onto our disk.

### Options (durable graph)

| Id | Option | Fits Fyber stack? | Lab cost / ops | Product fit |
| --- | --- | --- | --- | --- |
| **D1** | Multi-peer browser mesh as durability | Yes in spirit. **Not true today**: `localStorage: false`, few peers, STUN-only ICE. | Free. Honest empty after recycle + refresh. | End-state. Needs persist in the client (Gun IndexedDB / radisk in the browser — **not** `user.recall({ sessionStorage: true })`) plus enough peers / TURN. |
| **D2** | Azure Blob (or Files) behind the **existing snapshot**, not a new DB | Yes. Snapshot is already the Public bootstrap. Blob is cheap object storage; Files is the mount if someone later insists on radisk. | Lab: pennies for Blob of seeder JSON. Files mount + radisk is more ops and a step toward origin-server. | Keep Blob as **cache of seeder Public**. Do not let Files-backed radisk on App Service become the social origin. |
| **D3** | Separate Gun relay VM (infra, like GitLab / Odoo / `vm-pano-test`) | Yes as a **relay**, same class as a seed. Data disk can outlive App Service recycle. | One B-series + disk + Caddy. Same compose-VM habit as `terraform/panopticon-test`. | Fine as one operator of a Panopticon seed/relay product. Wrong as a forever s3r.ch-only origin. |
| **D4** | IPFS / other content-addressed store | No. Different protocol, not Gun HAM-merge, not in the stack. Extra daemon. | Avoid. | Avoid unless a later oracle needs a CID. Do not dual-write the feed. |

**Not an option:** growing the App Service container into a durable social origin (persistent radisk as the product archive, chat server, presence server). That breaks lock 1.

### Recommended durable-graph path

**Near-term lab (do not implement in this PR):**

1. Leave App Service radisk ephemeral. Recycle still empties `/app/data`. That stays honest.
2. If Public emptiness after recycle hurts the lab: persist **only** the existing `FeedSnapshot` JSON to Azure Blob (same shape `GET /api/feed` already returns). Rehydrate on boot the way `loadSnapshot` already does from disk. Still a cache. Still seeder Public only. Still not rooms / granted / chat.
3. Do **not** Azure-Files-mount radisk on the web app as the archive. That is how this becomes Mastodon on S1.
4. D1 stays the real durability for shared rooms / users / granted: more live peers, and later a **browser graph persist** that is not SEA `recall`. Until then, those graphs can be empty after recycle. Copy must keep saying so.
5. D3 is the right shape if the lab needs a seed that remembers shared puts across web-app recycles — a **relay VM**, not more App Service disk. Same graduation as TURN: infra first, Panopticon product later.

**Product end-state:**

The mesh is the archive. Popular items cache across peers. A seed (App Service or a relay VM) is bootstrap. If we still run a durable seed, it is a Panopticon open product (public peer list / relay API), not `s3rch-fyberlabs-prod` growing a disk.

**Backup / restore (when someone actually persists):**

- Export: versioned Gun nodes on the locked paths, including `unshared: 1` and grant-inbox `retracted: 1`.
- Import: admit / `fromGun*` fail-closed, then put. Do not replay SEA / SIWE / TURN secrets.
- Presence: drop expired heartbeats; do not restore them as “who is here.”
- Cost: Blob snapshot of a lab seeder is negligible. A relay VM is a small monthly VM + disk (same class as `vm-pano-test`, not a second S1). TURN bandwidth (below) is the expensive part once meetings exist.

---

## TURN

### ICE: keep STUN; when TURN is needed

Today (`lib/gun-webrtc.ts`): `opt.rtc.iceServers` defaults to **STUN** (`stun:stun.l.google.com:19302`). Signed-in `/feed` may replace that list with Panopticon allocate `{ iceServers, expiresAt }` via same-origin `POST /api/turn/allocate`. If allocate or ICE fails, `/feed` falls open to same-origin `/gun` / snapshot. That path stays.

| Mechanism | Role | Today |
| --- | --- | --- |
| **STUN** | Discover reflexive address; punch when NAT is friendly | Google public STUN. Keep it. |
| **TURN** | Relay media / data when both sides are behind symmetric NAT, or when UDP is blocked | Path A hop when `PANOPTICON_TURN_*` is set and SIWE session is live. Empty env / fail → none. Do not document Google as TURN. |
| **Seed `/gun` WebSocket** | Gun DAM over Cloudflare → App Service | Works as the fallback when WebRTC does not. |

TURN is needed when two **browsers** must exchange Gun (or later meeting) traffic and STUN cannot bind. It is not needed for Public snapshot hydrate. It is not a chat server. Chat / presence stay Gun `.on` even after TURN exists.

### Consumers

| Consumer | When | Bandwidth |
| --- | --- | --- |
| s3r.ch browser Gun (`gun/lib/webrtc`) | First. Data-channel DAM between browsers | Small (graph puts). Lab-sized. |
| Later meetings / streams | After this design. Media ICE on the same relay class | Large. Do not size the lab VM as if 100-person video is in scope. |
| Hypermesh | Same shared **TURN** relay is allowed if it uses the same URI contract. Hypermesh portal stays Keycloak; s3r.ch stays SIWE. Do not merge products. | Hypermesh WireGuard (`wg.test.hyperme.sh`) is the host tunnel, **not** the s3r.ch browser relay. Do not put coturn on that box as a cottage overlay. Do not send `/feed` clients through Tailscale. |

### Auth, credentials, secrets

TURN without auth is an open relay (abuse, cost). Static secrets in the client are the same leak.

| Rule | Why |
| --- | --- |
| Time-limited credentials (coturn `use-auth-secret` / TURN REST: username `expiry:id`, HMAC password) | A captured password dies. |
| Shared secret in Key Vault only (`kv-fyber-cg47`, same habit as `SEED_SECRET` / `IDENTITY_SESSION_SECRET`) | Not git, not `NEXT_PUBLIC_*`, not Gun. |
| Mint against the **same** `POST /api/v1/turn/allocate` contract (Panopticon). SIWE-gated for s3r.ch | Browser receives `{ iceServers, expiresAt }` from Next. Product API key stays on the server. No second mint API. |
| **Never put the long-lived TURN secret on a Gun node** | Graph is replicated. A secret there is public. |
| Do not put allocate credentials on Gun | Graph is replicated. A credential there is public. |

Lab / product mint: same allocate URI and JSON as path A; session-gated Next hop; checksummed address as `clientHint`; TTL minutes not days. Empty `PANOPTICON_TURN_BASE` / `PANOPTICON_TENANT_ID` / `PANOPTICON_API_KEY` keeps STUN + `/gun`. Unsigned visitors keep STUN + `/gun`. Cutover changes the host, not the path.

### Scale, regions, transports (Research Bot / Azure)

Prefer a **small dedicated Linux VM** over ACA Consumption. TURN wants stable **UDP** (3478 + a **capped relay port range**) and long-lived allocations. ACA Consumption is a poor fit without VNet / dedicated profiles (same class of reason `vm-pano-test` is a VM).

| Topic | Lab (if B) | Product (A) |
| --- | --- | --- |
| SKU / region | Start **B2s or B2ms**, **East US 2** (match existing Fyber farm). One public IP. | Same first region until real RTT pain. Then more relays, not a second control plane. |
| Seeder vs TURN | **Separate processes and hosts.** App Service = Gun seed. TURN VM = relay only. | Same split. Panopticon control plane (allocate) ≠ relay dataplane. |
| UDP | 3478 + chosen relay range. Cap the range early. Rate-limit allocations. | Same. Open-relay abuse is the bill. |
| TCP / TLS | `turns:` on **443** (and/or 5349) if you terminate TLS/DTLS. | Same. Browser clients need a public hole. |
| HA / AKS | **No.** Standard-era cheap. No AKS, no gold-plated HA until metrics say so. | Scale out relays when meetings exist. |
| Cost ballpark | One small VM + public IP + bandwidth. Graph puts are cheap; media later is not. | Bandwidth is the expensive part. Meter later (lock 6). |

**Egress / clients:** browsers on the public internet must reach the TURN host. Document **public** TURN (TLS/DTLS if you terminate). Do **not** design this as Private Endpoint–only — that boxes out `/feed` clients. Admin SSH stays on existing admin paths (Tailscale / jump), not a public 22 from the world.

### Cloudflare vs `/gun` WebSocket

Live s3r.ch is Cloudflare-proxied (`proxied = true`). Infra already documents that orange-cloud **passes** `/gun` 101 + Gun DAM. That is TCP WebSocket to App Service.

TURN is different:

- **UDP TURN cannot ride the orange-cloud.** Cloudflare proxy is not a STUN/TURN datagram forwarder.
- Infra already has the honest **DNS-only** pattern (`proxied = false`) for UDP (`wg.test.hyperme.sh`). TURN needs that class of hostname. That is not permission to send s3r.ch browsers through WireGuard or Tailscale.
- Do not put coturn on `s3r.ch` / `www` next to the site. Use a dedicated name (`turn.s3r.ch` or `turn.fyberlabs.com`), grey-cloud, ports 3478 UDP/TCP and 5349 TLS (or 443).
- Do not add a Cloudflare Worker as TURN. Do not change s3r.ch Terraform in the s3r.ch repo. Worker / Spectrum is not this design.
- `/gun` stays on the orange-cloud site. ICE stays in the browser. The two paths are complementary, not a merge.

### Options (TURN hosting)

| Path | Where it runs | Honest tradeoff |
| --- | --- | --- |
| **A — Panopticon product** | `products/…` cookie-cutter on [FyberLabs/panopticon](https://github.com/FyberLabs/panopticon) (today: `hypermesh`, `tennessee-windage`, `template`; no TURN product yet). Public allocate API. Others can run equivalents ([`open-services.md`](https://github.com/FyberLabs/hypermesh-docs/blob/main/open-services.md), same spirit as `distributed-market.md` “Any Panopticon”). Compute is still a UDP-capable host — ACA Consumption cannot be the relay dataplane. | Matches the lock. Slower for the lab: no product network exists yet. Control plane (issue creds, meter later) ≠ the relay process. |
| **B — Time-boxed infra coturn** | New FyberLabs/infra layer (sketch below). **Same allocate/ICE URI contract as A** from day one. s3r.ch mints against that contract. | Allowed only if the four B conditions hold. Fastest lab path. **Does not amend the lock.** Risk: ossifies as “the Fyber TURN” if cutover never happens. |
| **C — Infra-only forever** | Same VM, never a Panopticon API, never a market. | Conflicts with lock 5 / `open-services.md`. Only if Chris amends that lock in hypermesh-docs. This PR does not. |

App Service coturn, Cloudflare-as-TURN, and “Google STUN is enough” are not options.

### Recommended TURN path

**Product end-state: A.** Needed TURN is a Panopticon open product. Public credential API. Market of equivalents. Same URI contract from day one. s3r.ch consumes the API; it does not own the relay. Azure is not the Gun datastore.

**Near-term lab: optional B**, and only if every [Path B is legal only if](#path-b-is-legal-only-if) condition holds. Independent of Panopticon **as a process** — yes, a coturn in FyberLabs/infra can relay before the product network exists. Independent of Panopticon **as the lock** — no. Time-boxed. Identical contract. No product data on the VM. Graduation is DNS/config cutover.

**Path C:** do not take it unless the lock is amended in hypermesh-docs. No sibling `open-services.md` PR from this work — we are not proposing that amendment.

### Graduation (B → A): DNS / config cutover

Until cutover, say “interim infra,” not “Panopticon TURN.” The lock is satisfied when **all** of these are true:

1. A Panopticon product network exposes the **same** public allocate API (OpenAPI, documented TTL, ICE server list) — the contract below. Cookie-cutter from `products/template/`.
2. The shape is copyable: another operator can mint the same time-limited creds against their own secret and relay.
3. s3r.ch (and Hypermesh if it shares the relay) already call that contract. Cutover is changing the allocate **base URL** and/or the ICE hostname (CNAME / config), **not** a new client protocol.
4. The infra VM is retired **or** becomes **one** backend of that product (Fyber-operated). It is not a second control plane and never held Gun data.
5. Payments / metering may still be later (lock 6). The API can be free for the lab and priced later. Free-now does not mean infra-forever.

### Infra sketch (FyberLabs/infra later — do not apply here)

No Terraform in this repo. No apply. When Chris wants the lab relay, a sibling **infra** PR can follow the existing UDP VM pattern ([`terraform/panopticon-test/README.md`](https://github.com/FyberLabs/infra/blob/main/terraform/panopticon-test/README.md)):

| Piece | Sketch | Do not |
| --- | --- | --- |
| Layer | `terraform/turn` (or `mesh-relay`): **B2s / B2ms**, **East US 2**, public IP. Label interim / time-boxed | Put coturn on `terraform/s3rch` App Service, the shared S1, ACA Consumption, or AKS |
| Dataplane | coturn (or equivalent) with `use-auth-secret`; UDP **3478** + **capped relay range**; `turns:` **443** if you terminate TLS/DTLS. Rate-limit early | Store Gun / snapshot / rooms on this VM. Merge seeder and TURN on one host |
| DNS | Dedicated A (or later CNAME), **`proxied = false`**. Same name role the Panopticon contract will use | Orange-cloud on that hostname. Cottage WG/Tailscale as the client relay |
| Secrets | Long-lived auth secret in `kv-fyber-cg47`; UAMI read | Commit the secret; `NEXT_PUBLIC_*`; put it on Gun |
| NSG | Allow **UDP 3478** + the chosen relay range, and **443/tcp** if TURNS, from `0.0.0.0/0` (browser clients). Lock admin SSH to existing admin paths (Tailscale / jump) | PE-only ingress. Public SSH. Uncapped relay ports |
| Shared use | One public TURN for s3r.ch Gun first; Hypermesh may share the **TURN contract** | Put coturn on `vm-pano-test` / `wg.test`. Send `/feed` through Tailscale |
| s3r.ch consume (this slice) | Mint against the **same** allocate URI contract as A → `opt.rtc.iceServers` = STUN + time-limited `turn:` / `turns:` | A second mint API. Static password on live ICE. Product key in `NEXT_PUBLIC_*` |

`terraform/s3rch/README.md` already says: “TURN is later (Panopticon). … Do not add coturn or a Cloudflare Worker here.” That line stays until an infra PR exists. The sketch above is that later layer, not a change to the web-app module.

### Open-market shape (Panopticon, path A) — the URI contract

This is the contract **path B must implement on day one** so graduation is DNS/config, not a rewrite. When the product network exists, keep it boring and copyable:

```
POST /api/v1/turn/allocate
  auth: product API key or (s3r.ch) a SIWE-backed hop the product accepts
  body: { ttlSec, clientHint? }
  → { iceServers: [ { urls, username, credential } ], expiresAt }
```

- `urls` may include `turn:` and `turns:` on the operator’s **public** relay (not a Tailscale IP, not a PE-only host).
- Clients still include public STUN.
- No Gun writes. No SEA keys. No Keycloak as s3r.ch login. No graph on the relay.
- Metering / paid access later (crypto, optional fiat). The API is public even when free so others can sell the same shape.
- Interim B mint (if any) uses this path and this JSON. Cutover changes the host, not the shape.
- Fyber’s first operator can be the path-B VM behind this façade, then a CNAME to the Panopticon dataplane.

Do not invent a second control plane on s3r.ch Azure to do this.

### s3r.ch consume (this slice)

Honest smallest rule: **signed-in only**. The browser POSTs same-origin `/api/turn/allocate` (cookie). Next verifies the SIWE session, then hops with the product API key. Unsigned / missing env / 401 / 503 / network → STUN + `/gun`. Re-allocate before `expiresAt` by mutating the same `opt.rtc` object Gun's webrtc adapter closes over. Public `/` and `/feed` stay short visitor verbs.

Product locks (signed 2026-09-09). Do not expand this slice past these:

1. Next server only calls allocate. API key server-side only — never `NEXT_PUBLIC_*`, Gun, localStorage, or browser-visible.
2. SIWE stays on s3r.ch origin. No SIWE-as-Panopticon-login. No Keycloak. Wallet door parked.
3. After SIWE verified server-side, server may allocate for that session. Unsigned/failed allocate → keep STUN + `/gun` fail-open.
4. Re-allocate before `expiresAt`. Do not persist HMAC credential or `TURN_AUTH_SECRET` on Gun/public mesh.
5. No public-page architecture essays. Short connection status only.
6. Azure App Service stays seed peer, not TURN. This slice is allocate consume only.
7. No Hypermesh lease/Checkout/Stripe, oracles, payments, or “finished P2P mesh” claims.
8. Hermetic tests with mocked allocate — do not require live Panopticon in CI.

| Env (server-only) | Role |
| --- | --- |
| `PANOPTICON_TURN_BASE` | Allocate origin, or origin plus `/api/v1` / `/api/v1/turn` |
| `PANOPTICON_TENANT_ID` | `X-Tenant-ID` |
| `PANOPTICON_API_KEY` | `X-Api-Key`. Never `NEXT_PUBLIC_*`. |

Empty any of the three = STUN-only. Operator sets them on App Service (Key Vault later). This repo does not deploy coturn.

---

## Decision (for Chris)

| Question | This file’s answer | If you disagree |
| --- | --- | --- |
| End-state? | **Path A** — Panopticon open TURN product. Same allocate/ICE URI contract. Azure is not the Gun datastore. | — |
| Can TURN live in FyberLabs/infra independent of Panopticon **for the lab**? | **Optional path B**, and only if time-boxed, contract-identical, no product data, graduation = DNS/config cutover. SKU: B2s/B2ms, East US 2, public TURN, separate from the seeder. Not WG/Tailscale for browsers. | Prefer waiting for A: say so; lab stays STUN + `/gun`. |
| Does B replace Panopticon? | **No.** Lock 5 / `open-services.md` stay. Cutover retires the second plane. | Path C = amend `open-services.md` in hypermesh-docs. Not done here. |
| Durable graph on App Service disk? | **No** as the archive. Optional Blob of the existing Public snapshot. Mesh (D1) + optional seed relay VM (D3) for shared puts — **not** the TURN host. | Files-mount radisk is the Mastodon slope. |
| Implement now? | **Path A consume — this slice.** No infra coturn PR. | — |

Copy on `/feed` stays: STUN ≠ TURN; seed / snapshot if ICE fails; Network / Granted can be empty; not a finished P2P mesh.
