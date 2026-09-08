# Durable Gun graph and TURN (2026-09-08)

Design only. Sequence step 3 after live mesh delivery ([#40](https://github.com/FyberLabs/s3r.ch/pull/40)) and browser pull + HAM-merge ([#42](https://github.com/FyberLabs/s3r.ch/pull/42)). This file does **not** deploy coturn, mount a disk, change live ICE, or mint TURN credentials.

Parent: [ARCHITECTURE.md](ARCHITECTURE.md). Identity / Check locks stay in [identity.md](identity.md) and [s3rch-check.md](s3rch-check.md). Fyber-wide service lock: [FyberLabs/hypermesh-docs `open-services.md`](https://github.com/FyberLabs/hypermesh-docs/blob/main/open-services.md) (2026-09-02). Infra facts: [FyberLabs/infra `docs/PLATFORM.md`](https://github.com/FyberLabs/infra/blob/main/docs/PLATFORM.md) and [`terraform/s3rch/README.md`](https://github.com/FyberLabs/infra/blob/main/terraform/s3rch/README.md).

Chris can decide **Panopticon vs interim infra** from this file. The 2026-09-02 lock is not amended here.

## What this is / is not

This is an instrument-honest requirements note for two missing pieces:

1. **Durable graph** — what should still exist after an App Service recycle.
2. **TURN** — when STUN cannot punch NAT, and where that relay may live.

It is **not** a finished P2P mesh claim. `gun/lib/webrtc` is STUN-only today. Browser Gun uses `localStorage: false`. The seed peer is a cache. Chat and presence are Gun subscriptions, not WebRTC. Meetings / streams are later.

Out of this file: implementing coturn, Terraform apply, meetings/streams UI, putting TURN secrets on live ICE, Odoo/GitLab restyle.

## Steering locks (stay put)

From [ARCHITECTURE.md — Steering locks (2026-09-02)](ARCHITECTURE.md#steering-locks-2026-09-02) and `open-services.md`:

| Lock | Meaning here |
| --- | --- |
| Server footprint low or none | Azure App Service is seed / bootstrap, **not** a product DB or chat server. Ephemeral container disk is not the archive. End-state servers are TURN-class relays. |
| Open protocol, client P2P | Live state is Gun HAM-merge in clients, not a farm of origin servers. |
| Oracles / validators in the browser when possible | A service we still run should look like a relay / validator, not a privileged social backend. |
| Needed services live in **Panopticon** | Seed, TURN, paid access, oracles we cannot do in-browser: open product network, public APIs, market of equivalents. Do not grow s3r.ch Azure into that service. Do not invent a second control plane. |
| STUN ≠ TURN | Google `stun.l.google.com:19302` is STUN. It is not free TURN. No TURN on App Service. |

Chris asked whether TURN can deploy **in FyberLabs/infra as a service independent of Panopticon**. That tensions with the Panopticon lock. The three honest answers:

| Path | What it is | Lock |
| --- | --- | --- |
| **A** | Panopticon-hosted TURN product (open API, market of equivalents) | Matches the lock. |
| **B** | FyberLabs/infra coturn (or similar) as a shared relay for s3r.ch / Hypermesh first, with a later Panopticon façade | Interim ops. Lock **stays**. Graduation criteria below. |
| **C** | Fully independent infra-only forever | Conflicts with the lock unless `open-services.md` is amended. This file does not amend it. |

This file recommends **B for the near-term lab** and **A for the product end-state**. Path C is listed so the tension is visible. Choosing C is a lock change — do it in hypermesh-docs, not by silence here.

## Recommendation (lab vs product)

| | Near-term lab | Product end-state |
| --- | --- | --- |
| **Durable graph** | Keep App Service a seed. Survive recycle of the **public seeder cache** with Azure Blob (the existing `snapshot.json` shape). Do **not** mount radisk as a Mastodon-class origin. Shared rooms / users / granted / chat stay mesh + next seed. Optional later: browser graph persist (not SEA `recall`). | The mesh is the archive. Any durable seed is a Panopticon open relay others can run. App Service stays bootstrap. |
| **TURN** | **Path B.** One small infra VM (coturn), DNS-only hostname, time-limited creds from Key Vault. Shared by s3r.ch Gun WebRTC first. | **Path A.** Panopticon product network with a public credential API. Infra VM (if it still exists) is one operator of that product, not the product. |

Graduation from B → A is named below. Until then the lock is not rewritten.

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

Today (`lib/gun-webrtc.ts`): `opt.rtc.iceServers` is **STUN only** (`stun:stun.l.google.com:19302`). If ICE fails, `/feed` falls open to same-origin `/gun` / snapshot. That path stays.

| Mechanism | Role | Today |
| --- | --- | --- |
| **STUN** | Discover reflexive address; punch when NAT is friendly | Google public STUN. Keep it. |
| **TURN** | Relay media / data when both sides are behind symmetric NAT, or when UDP is blocked | **None.** Do not document Google as TURN. |
| **Seed `/gun` WebSocket** | Gun DAM over Cloudflare → App Service | Works as the fallback when WebRTC does not. |

TURN is needed when two **browsers** must exchange Gun (or later meeting) traffic and STUN cannot bind. It is not needed for Public snapshot hydrate. It is not a chat server. Chat / presence stay Gun `.on` even after TURN exists.

### Consumers

| Consumer | When | Bandwidth |
| --- | --- | --- |
| s3r.ch browser Gun (`gun/lib/webrtc`) | First. Data-channel DAM between browsers | Small (graph puts). Lab-sized. |
| Later meetings / streams | After this design. Media ICE on the same relay class | Large. Do not size the lab VM as if 100-person video is in scope. |
| Hypermesh | Same shared relay is allowed. Hypermesh portal stays Keycloak; s3r.ch stays SIWE. Do not merge products. | Router / WG is a different UDP path (`wg.test.hyperme.sh`). Do not overload that host as coturn without a decision. |

### Auth, credentials, secrets

TURN without auth is an open relay (abuse, cost). Static secrets in the client are the same leak.

| Rule | Why |
| --- | --- |
| Time-limited credentials (coturn `use-auth-secret` / TURN REST: username `expiry:id`, HMAC password) | A captured password dies. |
| Shared secret in Key Vault only (`kv-fyber-cg47`, same habit as `SEED_SECRET` / `IDENTITY_SESSION_SECRET`) | Not git, not `NEXT_PUBLIC_*`, not Gun. |
| Mint in a thin server route **or** a Panopticon API after SIWE (lab) / product auth (end-state) | Browser receives `{ urls, username, credential, ttl }`. |
| **Never put the long-lived TURN secret on a Gun node** | Graph is replicated. A secret there is public. |
| Do not change live ICE in this PR | No `turn:` URLs, no minted creds, no App Service TURN. |

Lab mint shape (later implementation, not this PR): session-gated, checksummed address as the id, TTL minutes not days. Fail closed if the secret is missing in production (same class as identity cookies). Unsigned visitors keep STUN + `/gun`.

### Scale, regions, transports

| Topic | Lab | Product |
| --- | --- | --- |
| Regions | One Azure region next to the existing farm (same as s3r.ch / `vm-pano-test`) | More regions when meetings need RTT. Not a second control plane — more relays. |
| UDP | Required for real TURN. App Service and ACA Consumption **cannot** do this (same reason Hypermesh test is a VM: UDP 51820 / TUN). | Same. Relays are VMs (or equivalent), not the S1 web app. |
| TCP / TLS (`turn:` / `turns:`) | Offer as fallback when UDP is blocked (corporate NAT). | Same. `turns:443` is the usual firewall hole. |
| Scale | One small B-series. Watch egress. | Horizontal relays behind a public allocate API. Bandwidth is the bill. |

### Cloudflare vs `/gun` WebSocket

Live s3r.ch is Cloudflare-proxied (`proxied = true`). Infra already documents that orange-cloud **passes** `/gun` 101 + Gun DAM. That is TCP WebSocket to App Service.

TURN is different:

- **UDP TURN cannot ride the orange-cloud.** Cloudflare proxy is not a STUN/TURN datagram forwarder.
- Infra already has the honest pattern: `terraform/panopticon-test` uses **DNS-only** (`proxied = false`) A records for WireGuard UDP. TURN needs the same class of hostname.
- Do not put coturn on `s3r.ch` / `www` next to the site. Use a dedicated name (`turn.s3r.ch` or `turn.fyberlabs.com`), grey-cloud, ports 3478 UDP/TCP and 5349 TLS (or 443).
- Do not add a Cloudflare Worker as TURN. Do not change s3r.ch Terraform in the s3r.ch repo. Worker / Spectrum is not this design.
- `/gun` stays on the orange-cloud site. ICE stays in the browser. The two paths are complementary, not a merge.

### Options (TURN hosting)

| Path | Where it runs | Honest tradeoff |
| --- | --- | --- |
| **A — Panopticon product** | `products/…` cookie-cutter on [FyberLabs/panopticon](https://github.com/FyberLabs/panopticon) (today: `hypermesh`, `tennessee-windage`, `template`; no TURN product yet). Public allocate API. Others can run equivalents ([`open-services.md`](https://github.com/FyberLabs/hypermesh-docs/blob/main/open-services.md), same spirit as `distributed-market.md` “Any Panopticon”). Compute is still a UDP-capable host — ACA Consumption cannot be the relay dataplane. | Matches the lock. Slower for the lab: no product network exists yet. Control plane (issue creds, meter later) ≠ the relay process. |
| **B — Infra coturn first** | New FyberLabs/infra layer (sketch below), same compose-VM + Key Vault + DNS-only habit as GitLab / Odoo / `panopticon-test`. s3r.ch (and later Hypermesh) point ICE at it after a credential mint. | Fastest lab path. **Does not amend the lock.** The VM is an interim operator. Graduation criteria below. Risk: it ossifies as “the Fyber TURN” if nobody builds the façade. |
| **C — Infra-only forever** | Same VM, never a Panopticon API, never a market. | Conflicts with lock 5 / `open-services.md`. Only if Chris amends that lock in hypermesh-docs. This PR does not. |

App Service coturn, Cloudflare-as-TURN, and “Google STUN is enough” are not options.

### Recommended TURN path

**Near-term lab: B.** Independent of Panopticon **as a process** — yes, Chris, a coturn (or similar) in FyberLabs/infra can be a shared relay without waiting for a Panopticon product network. Independent of Panopticon **as the lock** — no. The lock stays. The VM is not the product.

**Product end-state: A.** Needed TURN is a Panopticon open product. Public credential API. Market of equivalents. s3r.ch consumes the API; it does not own the relay.

**Path C:** do not take it unless the lock is amended in hypermesh-docs. No sibling `open-services.md` PR from this work — we are not proposing that amendment.

### Graduation criteria (B → A)

The lock is satisfied when **all** of these are true. Until then, say “interim infra,” not “Panopticon TURN.”

1. A Panopticon product network exposes a **public** allocate API (OpenAPI, documented TTL, ICE server list). Cookie-cutter from `products/template/`.
2. At least the **shape** is copyable: another operator can mint the same time-limited creds against their own secret and relay.
3. s3r.ch (and Hypermesh if it shares the relay) call that API. They do not hardcode `turn.fyberlabs.com` + a baked secret as the product contract.
4. The infra VM, if it still exists, is **one** backend of that product (Fyber-operated), not a second control plane.
5. Payments / metering may still be later (lock 6). The API can be free for the lab and priced later. Free-now does not mean infra-forever.

### Infra sketch (FyberLabs/infra later — do not apply here)

No Terraform in this repo. No apply. When Chris wants the lab relay, a sibling **infra** PR can follow the existing UDP VM pattern ([`terraform/panopticon-test/README.md`](https://github.com/FyberLabs/infra/blob/main/terraform/panopticon-test/README.md)):

| Piece | Sketch | Do not |
| --- | --- | --- |
| Layer | `terraform/turn` (or `mesh-relay`) on a small Ubuntu VM + data disk, B-series | Put coturn on `terraform/s3rch` App Service or on the shared S1 |
| Dataplane | coturn (or equivalent) with `use-auth-secret`; UDP 3478, TCP 3478, TLS 5349/443 | Cloudflare `proxied = true` on that hostname |
| DNS | Dedicated A record, **`proxied = false`**, same honesty as `wg.test.hyperme.sh` | Reuse `s3r.ch` orange-cloud |
| Secrets | Long-lived auth secret in `kv-fyber-cg47`; UAMI read; render into coturn config on refresh | Commit the secret; put it in `NEXT_PUBLIC_*`; put it on Gun |
| NSG | 3478/udp, 3478/tcp, 5349/tcp (or 443) from `0.0.0.0/0`; SSH via Tailscale | Open the relay without auth |
| Shared use | One relay for s3r.ch Gun first; Hypermesh may join | Merge s3r.ch SIWE with Hypermesh Keycloak |
| s3r.ch consume (later product PR) | SIWE-gated mint → `opt.rtc.iceServers` = STUN + time-limited `turn:` / `turns:` | Ship ICE URLs with a static password in this design PR |

`terraform/s3rch/README.md` already says: “TURN is later (Panopticon). … Do not add coturn or a Cloudflare Worker here.” That line stays until an infra PR exists. The sketch above is that later layer, not a change to the web-app module.

### Open-market shape (Panopticon, path A)

When the product network exists, keep it boring and copyable:

```
POST /api/v1/turn/allocate
  auth: product API key or (s3r.ch) a SIWE-backed hop the product accepts
  body: { ttlSec, clientHint? }
  → { iceServers: [ { urls, username, credential } ], expiresAt }
```

- `urls` may include `turn:` and `turns:` on the operator’s relay.
- Clients still include public STUN.
- No Gun writes. No SEA keys. No Keycloak as s3r.ch login.
- Metering / paid access later (crypto, optional fiat). The API is public even when free so others can sell the same shape.
- Fyber’s first operator can be the path-B VM behind this façade.

Do not invent a second control plane on s3r.ch Azure to do this.

---

## Decision (for Chris)

| Question | This file’s answer | If you disagree |
| --- | --- | --- |
| Can TURN live in FyberLabs/infra independent of Panopticon **for the lab**? | **Yes (path B).** UDP relay does not fit App Service or ACA Consumption. Infra already runs that class of VM. | Prefer waiting for A before any relay: say so; lab stays STUN + `/gun`. |
| Does that replace Panopticon? | **No.** Lock 5 / `open-services.md` stay. B is interim. Graduation is the five bullets above. | Path C = amend `open-services.md` in hypermesh-docs. Not done here. |
| Durable graph on App Service disk? | **No** as the archive. Optional Blob of the existing Public snapshot. Mesh (D1) + optional relay VM (D3) for shared puts. | Files-mount radisk is the Mastodon slope; only if you explicitly want the seed to remember shared rooms across recycles **as cache**, and you accept the ops. |
| Implement now? | **No.** Docs only. Next product PRs: Blob snapshot and/or infra coturn, then SIWE-gated ICE — each as its own slice. | — |

Copy on `/feed` stays: STUN ≠ TURN; seed / snapshot if ICE fails; Network / Granted can be empty; not a finished P2P mesh.
