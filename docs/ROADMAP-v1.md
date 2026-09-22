# s3r.ch v1 roadmap (remaining)

2026-09-22. Updated remaining-work list. Detail and locks stay in [ARCHITECTURE.md](ARCHITECTURE.md). Bot-plane draft: [bot-plane-compatibility.md](bot-plane-compatibility.md).

Open source s3r.ch is compatibility with familiar client shapes, not a clone of Discord, Slack, Linear, or Jira. Gun is the graph. Azure App Service is a seed peer, not the chat server. Panopticon is the open service plane (TURN, oracles, payments). Do not invent a second control plane.

Bot plane and light project objects below are **planned v1**. They are not live. The P0 target is a draft for Product review.

## Already largely shipped

Summaries only. Do not treat this list as a new spec.

- **SIWE + held claims.** Cookie session bound to the checksummed address. EOA ecrecover, plus mainnet ERC-1271 / EIP-6492. ENS, Unstoppable, Farcaster, Lens, and RSS3 held claims after auth. Email / phone confirm and a fixture KYC attestation are private held claims. Mine until explicit share. [identity.md](identity.md).
- **Mine / Public / Network / Granted.** Public is snapshot hydrate plus shared puts. Mine is the overlay. Network is live Gun `.map().on` on `s3rch/items` and `s3rch/rooms`. Granted is the see-grant inbox.
- **Rooms, Gun chat, presence.** Rooms are Gun threads. Live chat and presence are Gun subscriptions on a room the reader can already see. SIWE to send or announce. Not a hosted transcript. Not WebRTC.
- **Check see-grants + delivery inbox.** Light Check in the browser, mesh `s3rch/acl` rows, holder put onto `s3rch/granted/<accessor>`. Revoke is immediate on the dest ACL. First delivery can wait. [s3rch-check.md](s3rch-check.md).
- **Discoverability tags.** Discover browses tags already on Public and the live Network mesh. Not search. Not Popular / Novel.
- **Unshare.** Own-only HAM tombstone or claim republish. Observation can wait. Not a grant revoke. Not instant everywhere.
- **Browser pull + bridges prep.** Signed-in pull of the documented public sources through `/api/ingest` or the allowlisted extension / `127.0.0.1` relay. Admit onto Mine. Share is a separate put. [pull-relay.md](pull-relay.md).
- **Panopticon TURN allocate (path A).** Session-gated `POST /api/turn/allocate`, fail-soft. Empty env stays STUN-only. This repo does not deploy coturn. [durable-graph-and-turn.md](durable-graph-and-turn.md). Oracles attest and payments receipt/intent hops are the same consume pattern (fail-soft, no paywall). [oracles-and-payments-prep.md](oracles-and-payments-prep.md).
- **Outbound Farcaster / ATProto when env is set.** Explicit SIWE `POST /api/outbound` on an owned native post. Missing creds fail closed. Not an auto-bridge. ActivityPub and Nostr outbound are not wired.

## Remaining v1

### 1. Bot plane P0

**Outcome.** A neutral OpenAPI event + write surface, bot tokens distinct from SIWE sessions, room ≈ channel with Check as the ACL, and thin Slack / Discord adapter mappings (compat shapes only).

**Depends on.** Rooms, Gun chat, Check see-grants, and human SIWE sessions. The bot is its own principal. It does not replace those.

**Done when.** The surface is documented as s3r.ch-native and matches [bot-plane-compatibility.md](bot-plane-compatibility.md). A hello-world bot subscribes to `room.message.created`, `POST`s a reply onto the room chat path, and receives a webhook. A human sees the reply in the existing room UI. Bolt, n8n, and Cursor-style clients can attach through the native HTTP surface or the thin adapters, without a custom SDK. Full Discord Gateway, full Slack Bolt, and permission bitfields stay out. Secrets stay off the public Gun graph.

**Status.** Planned. Draft until Product accepts the P0 target (neutral OpenAPI + thin adapters).

### 2. Light project objects in rooms

**Outcome.** Typed issue and task posts (status, assignee) that live in a room and emit the same events as chat.

**Depends on.** Item 1’s event bus, plus rooms and Check. Mine-until-share unchanged.

**Done when.** A human creates and updates an issue or task in the existing room UI (room-native — not a Linear or Jira clone). A subscribed bot receives `room.object.created` / `room.object.updated` and can write back through the same REST surface. No second product.

**Status.** Planned v1. Specify the event names with P0. Ship the objects once that bus exists.

### 3. Meetings / streams

**Outcome.** Live meetings and streams on the mesh, using TURN where ICE needs a relay.

**Depends on.** Bot plane basics (item 1), so a meeting can share the room event bus. Path A TURN allocate already consumes Panopticon and fails soft. Chat and presence stay Gun subscriptions; they are not this product.

**Done when.** A room can host a meeting or stream without a hosted chat server, without TURN on App Service, and without a second control plane. ARCHITECTURE’s “meetings / streams later” is this item.

**Status.** Later in v1, after bot plane basics. Not started.

### 4. Operator polish

**Outcome.** RSS3 GI lists seed again when `gi.rss3.io` has public DNS. Operators keep the durable-graph and TURN honesty already written down.

**Depends on.** DNS for `gi.rss3.io` (outside this repo). Requirements already in [durable-graph-and-turn.md](durable-graph-and-turn.md). Path A allocate consume already ships when `PANOPTICON_TURN_*` is set.

**Done when.** A GI DNS or HTTP failure still writes nothing and does not empty other sources. When the host resolves, the documented GI lists seed again. Operators follow the existing TURN checklist. Container disk is not the archive. App Service is not the relay.

**Status.** GI is blocked on DNS. Durable graph stays requirements-only (the mesh is the archive). TURN consume is shipped; coturn is not deployed here.

### 5. Parked (not v1 blockers)

- **ERC-1271 SIWE on non-mainnet chains.** Mainnet ERC-1271 / EIP-6492 already verifies. Any other `chainId` stays EOA-only. [identity.md](identity.md).
- **Hypermesh wallet door.** SIWE and Keycloak for the same user, later. s3r.ch does not use Keycloak as an IdP. Login here stays EIP-4361.
- **Full ActivityPub / Nostr outbound.** Inbound pull ships. Farcaster and ATProto outbound ship when env is set. Posting to ActivityPub or Nostr does not.
- **Popular / Novel search API.** Discover stays a browse of tags already on Public and Network. No `/api/search`. No engagement columns.

## Framing

Humans and bots ease in through familiar event, webhook, and REST shapes. The graph they write is still Gun. Grants are still Check. The P0 surface is a draft until Product accepts it.
