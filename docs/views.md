# Views: personal workspaces of saved sources (design, v0)

Design draft for a user-defined workspace that shows chats, forums, feeds and, later, streams and voice rooms from several origins in one interface. Related: [ARCHITECTURE.md](ARCHITECTURE.md), [s3rch-check.md](s3rch-check.md), [forum.md](forum.md), [ROADMAP-v1.md](ROADMAP-v1.md).

## 1. What exists today

| Area | Finding |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, TanStack Query. Standalone Node server; Gun seed peer at same-origin `/gun`. |
| Mobile | No native app, no Capacitor/React Native, no PWA manifest found. Responsive web only. |
| Component library | None. Hand-written components in `components/` (`RoomsList`, `RoomChat`, `RoomPresence`, `FeedStream`, `DiscoverPanel`, `ForumDesk`, `ComposeForm`, `ProviderMark`, `TagChips`, `brand.tsx`). |
| Routes | `/` (landing), `/feed` (Public / Mine / Network / Granted tabs, Discover, Rooms), `/forum` (owner forum + desktop feed). APIs: `feed`, `forum`, `ingest`, `outbound`, `identity/*`, `turn/allocate`, `payments/*`, `oracles/attest`, `seed`, `health`. |
| Data model | `FeedItem` (`source` ∈ rss3, rss, atom, farcaster, atproto, activitypub, nostr, s3rch). **Room** = Gun thread on `s3rch/rooms` (owner wallet, title, tags). **Chat** = `GunChatNode` on `s3rch/rooms/<id>/chat` (280-char cap). **Presence** = `s3rch/rooms/<id>/presence`. **Forum channel** = one per owner, JSON file server-side, with invites/groups/bots. No "server" grouping above rooms; no stream/voice object. |
| Ingest | Pull-only, read-only: Farcaster hub, ATProto AppView, RSS/Atom, ActivityPub outbox, Nostr kind 1, RSS3 GI (blocked on DNS). Through `/api/ingest` proxy, MV3 extension, or a `127.0.0.1` relay. Outbound posting: Farcaster, Bluesky only (explicit). |
| Not present | Discord, Matrix, Slack, Twitch/YouTube/HLS video, voice, meetings/streams (ROADMAP item 3, not started), bot plane (item 1, planned), search API (explicitly none). |
| Access | SIWE session; light SociACL Check see-grants in browser (`s3rch/acl`, `s3rch/granted/<accessor>`); Mine / share-into-mesh / unshare semantics; TURN via Panopticon, fail-soft. `lib/identity/sea.ts` exists for SEA. |

So today the "servers" a user can browse are: s3r.ch rooms (owned, shared, granted), forum channels (own + shared), and pulled public sources (per account/feed). Live video and voice come later.

---

## 2. Concepts

- **Source**: one readable stream of content with a stable `sourceRef`: a room chat, forum channel, ATProto/Farcaster/Nostr/AP account or feed, RSS feed, and later a stream or voice room. Kinds: `chat | forum | feed | stream | voice`.
- **Server = data origin.** Three levels:
  - **Network**: this s3r.ch deployment, another s3r.ch deployment (separate network with its own seed peer; *v0 assumption:* added by URL plus a permitted key, with a directory coming later. Each network runs in its **own isolated Gun instance** (own peers, own local store), so identical souls on two networks never merge; cross-network requests and grants are a later goal, not v0, because doing them securely needs substantial work), or an open protocol (ATProto, Farcaster, Nostr, ActivityPub, RSS, later Matrix etc.).
  - **Owner**: a user or org inside that network, stored as a **stable identifier**: checksummed wallet or org id on s3r.ch, DID on ATProto, FID on Farcaster, hex pubkey on Nostr, actor id URL on ActivityPub, feed origin for RSS. Handles (ATProto handle, Farcaster username, npub display) are resolved for display only and never persisted as the owner.
  - **Source**: a channel/feed/stream owned by that owner.
  Servers are for browsing; a View stores only full source references.
- **Window**: one tile in a View. It has a `kind` and **1..N sources**.
- **View**: a saved, named set of windows plus layout. Stored locally in IndexedDB with an encrypted backup (§5).

```ts
// network: "s3rch:" + scheme + "://" + host + ":" + port + ";key=" + keyFingerprint  (structured, not a URL fragment)  (this or another deployment;
//          scheme, host and explicit port are kept, keyFingerprint = SHA-256 of the permitted key, so a changed key
//          or scheme is a different network and is shown as such). The key is verified at the application layer,
//          since browsers cannot read the peer's TLS key: on connect the client sends a random nonce to
//          /.well-known/s3rch-network and the network answers with a descriptor {url, nonce, ts} signed by the permitted
//          key; a missing or bad signature means the network is unavailable. Only https URLs with a public hostname
//          are accepted (no IP literals in private, loopback or link-local ranges). Browsers cannot pin DNS for fetch
//          or WebSocket, so v0 relies on that check plus the browser's private-network protections; full address
//          pinning for the challenge and the Gun connection is a limitation until a connector exists (PR 13). This key identifies the network only;
//          it never vouches for users, keys, grants or messages. | "atproto" | "farcaster" | "nostr" | "activitypub" | "rss" | ...
// owner:   stable id: checksummed wallet / org id / DID / FID / Nostr hex pubkey / actor id URL / feed origin (never a handle)
// source:  provider-local id (room id, forum channel, feed URL, stream id)
type SourceRef = { network: string; owner: string; source: string; kind: "chat"|"forum"|"feed"|"stream"|"voice"; bindingHash?: string; v: 1 };
// bindingHash: H(current owner binding) for s3r.ch sources (§3.12); persisted in Views, backups and templates.
// canonical string: "sr1:" + pct(network) + "/" + pct(owner) + "/" + pct(source) + "/" + kind
//   pct() = percent-encode every byte outside RFC 3986 unreserved (A-Z a-z 0-9 - . _ ~), so "/" and ":" inside
//   components are always escaped and the encoding is injective. Parsing splits on "/" then decodes; a component
//   that is empty or re-encodes differently is rejected. Identity comparison uses network/owner/source/kind only.
// shareable string: canonical + "?b=" + pct(bindingHash) when present, so copied references keep the binding hint.
type Window = { id: string; kind: "chat"|"forum"|"feed"|"stream"|"voice"; sources: SourceRef[]; mode: "single"|"tabs"|"merged"; label?: string; colorBy?: Record<string,string> };
// Invariants, checked on every window on create, load and import (PR 1 schema, PR 5 validation, with tests):
//   - View.windows.length ≤ max windows (12) on create, load and import, checked before layout repair
//   - before any recursive work, an imported layout is rejected if it exceeds a maximum depth (8) or node count
//     (2 × max windows); validation is iterative, not recursive
//   - Window.id is nonempty and unique within the View; on import, duplicates are regenerated (with a visible
//     notice) before layout repair, and leaves that pointed at a duplicate are dropped and re-appended
//   - every source.kind === window.kind
//   - mode "single": exactly 1 source (the only mode for stream and voice)
//   - mode "tabs":   2..8 sources, kind chat | forum | feed
//   - import limits, checked before parsing into objects: serialized size cap, total sources per View cap,
//     per-window source cap (8)
//   - mode "merged": 2..8 sources, kind feed only
//   An invalid window is dropped from the loaded View with a visible notice; it is never repaired silently.
// LayoutTree = { type: "leaf"; windowId: string } | { type: "split"; dir: "row"|"col"; sizes: number[]; children: LayoutTree[] }
// After dropping windows, the layout is re-validated: leaves must reference unique surviving window ids,
// splits with 0 children are removed, splits with 1 child collapse into it, sizes are renormalized, and
// surviving windows without a leaf are appended. If no windows survive, layout becomes null. If the result is still invalid, the default grid is used (PR 1).
type View = { id: string; title: string; windows: Window[]; layout: LayoutTree | null; v: 1 };
// layout is null exactly when windows is empty (an empty View shows the empty-slot "+" state); otherwise it must be a valid tree.
```

---

## 3. The picker (core)

### 3.1 Two-step model, plus quick add

1. **Window**: pick an existing window or create a new one. The kind is **inferred** from the first source chosen (room → chat, RSS → feed, stream URL → stream). You can override it, but only to compatible kinds.
2. **Fill**: choose one or more sources for that window.

**Quick add** combines both steps: picking a source from any entry point while no window is targeted creates a new window of the inferred kind in the next free slot. **Choosing 2+ sources defaults to split windows, one per source**, each with decorators (source color, label, origin badge `network › owner`). For feeds only, the tray offers "Merge feeds into one window".

### 3.2 Entry points (they all open the same picker with a different starting state)

| Entry | Target window | Picker opens at |
| --- | --- | --- |
| Empty-slot `+` | new window in that slot | Recents tab |
| Window header `⊕ Add source` | that window | Browse, filtered to compatible kinds |
| Command palette `Ctrl/⌘K` → "Add…" | new window (quick add) | search box focused |
| Drag from sidebar (server tree) onto slot/window | drop target | no picker; drop zone shows *New window / Add to window / Replace* |
| Paste URL or invite (`Ctrl/⌘V` on the View, or in the picker) | new window unless a window is focused | URL resolver result card |
| "Add to view" while browsing a server/room page | asks which View → window | Step 1 with the source preselected |

### 3.3 Step 1: choose or create window (desktop)

```
┌ Add to view: "Dev + streams" ───────────────────────────── ✕ ┐
│ Where should it go?                                          │
│ (•) New window  [Kind: Auto ▾]  slot: right of "build-chat"  │
│ ( ) Add to existing:                                         │
│      ▢ build-chat      chat · 2 sources (s3r.ch, Farcaster)  │
│      ▢ Stage           stream · 1 source                     │
│      ▢ News            feed · 3 sources                      │
│                                                              │
│                              [Cancel]  [Next: choose source] │
└──────────────────────────────────────────────────────────────┘
```
Skipped when the entry point already fixes the target (`+`, `⊕`, drop).

### 3.4 Step 2: choose sources (desktop)

```
┌ Add sources → new window (Auto) ──────────────────────────────────── ✕ ┐
│ [🔍 Search everything you've joined…        ] [Paste URL]              │
│ Tabs: Recents | Favorites | Browse | Granted                           │
│ Filters: [Chat][Forum][Feed][Stream][Voice]  [● Live now]  [Unread]    │
├───────────────────────────┬────────────────────────────────────────────┤
│ NETWORKS                  │ PREVIEW: #build (s3r.ch › 0xA1…ff)         │
│ ▾ This network (s3r.ch)   │  12 here now · last msg 2m ago             │
│   ▾ Me (0xA1…ff)          │  0x9c…: deploy green on main               │
│      ☑ # build    ● 12    │  0x41…: ship it                            │
│   ▾ Org: FyberLabs        │  ─────────────────                         │
│      ☐ # ops (granted)    │  Access: ✓ can read · ✓ can post           │
│      🔒 # finance [Request]│                                           │
│ ▸ Other networks          │                                            │
│   ▸ lab.example (s3r.ch)  │                                            │
│ ▸ Protocols               │                                            │
│   ▸ Farcaster ▸ /dev      │                                            │
│   ▸ ATProto ▸ @alice.bsky │                                            │
│   ▸ RSS ▸ hn.example      │                                            │
├───────────────────────────┴────────────────────────────────────────────┤
│ Selected (2): [#build ✕] [/dev Farcaster ✕]                            │
│ Windows: (•) One per source (default)   ( ) Merge feeds (feeds only)  │
│                                          [Back]  [Add 2 sources]       │
└────────────────────────────────────────────────────────────────────────┘
```

**Browsing many providers**
- **Recents**: the last 20 sources the user opened or added, from local IndexedDB (§5). **Favorites**: starred sources, private.
- **Search** covers two scopes in one result list, both filtered by the selected type (chat, forum, feed, stream, voice):
  - **Joined**: owned, shared, granted, pulled and favorite sources. Searched in the browser.
  - **Public**: public rooms and sources plus tag matches on the shared mesh, including other networks the user has added.
  Results are grouped by origin and carry an access badge.
  - *Constraint:* the repo says there is no search API, and Discover is "not search".
  - *Public visibility (defined first):* `checkSee` today allows only the owner or a live grant (`lib/identity/check.ts`); it has no notion of public. For Views, **public** means: the object node is on a shared path (`s3rch/rooms`, `s3rch/items`; forum channels are never public) through explicit share-into-mesh, carries no unshare marker, and the share (and any unshare tombstone) is **signed by the owner** with the owner's source-scoped binding key, carrying a signed version `(shareSeq, deviceId)` and the digest and version of the exact shared object `SHA-256(JCS(normalize(node)))`, where `normalize` applies the reader defaults (missing `v` → 1, `tags` as the stored comma string, absent optional fields omitted, `unshared` removed) and JCS is RFC 8785 canonical JSON, and written once to the owner's authenticated namespace (§3.12 storage rule). The highest valid `shareSeq` decides between share and unshare, independent of Gun state, so replaying an older share cannot undo an unshare; if two devices emit the same `shareSeq`, unshare wins, then the higher `deviceId`. The shared object itself is stored content-addressed (Gun `#` soul keyed by its digest), so the signed share always points at a copy honest peers will not let anyone overwrite. The legacy shared path is only a locator; readers display the object fetched by digest and ignore whatever is on the mutable path (PR 24). `GunRoomNode` and `GunFeedNode` carry no owner signature today, so any peer could forge a share or tombstone naming another wallet. Unsigned shared nodes are never returned as `public`; *v0 limitation:* until PR 24 and PR 25 land, they are shown with the claimed owner marked "unverified" and are not grouped under that owner. Owner-signed shares apply **only to s3r.ch-owned sources** (native rooms and posts). Items pulled from open protocols (Farcaster, ATProto, Nostr, ActivityPub, RSS) are public by the protocol, not by a wallet share: they stay public, are attributed to the protocol author with the relaying s3r.ch user shown only as "relayed by", and are marked unverified unless the original protocol proof (signature or source URL fetch) is kept and checked. Public content is plaintext by design. A Check wrapper in s3r.ch returns `{allowed, reason: "public"}` for such nodes and defers to `checkSee` for everything else (PR 25).
  - *v0 mechanism (decided):* a browser-side index of joined sources plus live mesh tag and public-room discovery. The searcher's client filters every candidate through Check before showing content; locked hits show metadata only. No new service; results only cover peers reachable right now. Hop depth is 1, so there are no friend-of-friend walks.
  - *Later (post-v0):* server-side search over the permission graph. It is blocked on an open SociACL question about group search tokens.
- **Browse**: origin tree **Networks → users/orgs → sources**. Networks are grouped as *This network*, *Other s3r.ch networks* (added by URL; read through that deployment's seed peer) and *Protocols*. Lazily expanded. Each source gets a checkbox; a server gets a tri-state "select all visible". Selections stay across tabs and filters.
- **Filters**: by kind; **Live now** (signed presence heartbeat within TTL from a signer with live see permission, or a stream marked live); **Unread** (local cursor).
- **Previews** go through Check exactly like reads. Check-filtering is a display rule, not confidentiality: any peer that replicates a plaintext node can read it. Content of non-public sources must therefore be encrypted on the graph as specified in [encrypted-discovery.md](encrypted-discovery.md). *v0 limitation:* until that design ships, Views never puts locked content on shared paths, Mine stays local, and grant-delivered rows (plaintext in `s3rch/granted/…` today, see the known issue in that doc) are treated as visible to the mesh. A locked source shows **no content**, only metadata the user can already see (name, owner, kind). Readable previews only show data that already exists: last 2–3 messages (room chat / forum read / pulled items), presence count (rooms only; counts only signed heartbeats whose signer has live see permission, rejecting any `ts` more than a configurable skew ahead of the reader's clock and expiring entries by reader-observed time, since `isPresenceLive` in `lib/presence.ts` trusts `ts` alone. `GunPresenceNode` is unsigned today, so *v0 limitation:* presence counts and Live now are hidden until signed heartbeats land, PR 32), live thumbnail (streams, later). Fields with no data are hidden, never shown as "0" or as placeholders.

### 3.5 One window, several origins?

- **Feeds: yes.** A merged feed window orders items by `ts` **clamped** to a window around the reader's observed/fetch time (future timestamps are set to the observed time), with observed time as the tiebreaker, so one source cannot pin rows to the top with far-future dates. Every row carries a source chip (color, label, origin badge). The header lists the sources as removable chips. Starting cap: 8 sources.
- **Chat and forum: no, not in v0.** One source per window. Several chats sit side by side as split windows with decorators, or as tabs inside one window (tabs are views, not a merge).
- **Stream / voice:** one source per window, which can have a linked chat window.
- **Future, not v0:** merged chat using a higher-level @-reply addressing protocol. Each reply carries its target source, and replies could be routed with AI assistance. This needs a protocol spec first.

### 3.6 Swap, replace, move, undo
- Window header menu: **Replace source…** (opens the picker in single-select mode), **Move source to window…**, **Split out** (source → new window), **Merge with…**.
- Drag a source chip between windows: move by default, `Alt` to copy. Drop zones label the action.
- Swap two windows: drag a header onto another header.
- Every change goes into an undo stack (20 deep, per session): `Ctrl/⌘Z` / `Shift+Ctrl/⌘Z`, plus a toast "Moved #build → Stage · Undo" lasting 8 s. Config changes only; nothing is ever deleted at the source.

### 3.7 Permissions inline
Each row shows its state from SociACL Check before the user commits:
- `✓ read` / `✓ post`: the user can read, and possibly post.
- `🔒 Request access`: the room is known but the user has no see-grant. This opens a small form (scope: read / read+post, optional message) and creates an access request (§3.12). If an auto-approve rule matches, the owner's or admin's client issues the grant when it is online. Until then, and until the grant is live in Check, nothing implies access. Otherwise the row can be added as *pending*, and the window shows "Waiting for access" until the grant lands in `s3rch/granted/<me>`, or shows "Request declined".
- `Add` (public): a public source needs no membership. Adding it only subscribes this View; nothing is written to the source. *Dependency:* a real `Join` (a membership record the owner can see and remove) does not exist for Gun rooms or forum channels today; forum invites are direct and need no accept step. A Join action is deferred to the bot-plane room membership work (ROADMAP item 1) and is not shown in v0.
- `Sign in required`: signed out.
- `Read-only (posting not linked)`: Bluesky / Farcaster sources. The current outbound adapters use one deployment-wide account (`ATPROTO_IDENTIFIER` / Farcaster signer env). *v0 limitation:* the composer cannot target these until per-user credential binding lands (PR 22).
- `Read-only`: pulled public sources (no outbound for AP/Nostr/RSS).
Revoke is immediate on the dest ACL: the window keeps its slot and shows "Access removed". It never silently disappears.

### 3.8 URL / invite paste
Resolver order: s3r.ch room/forum link → ATProto (`bsky.app/profile/…`, `at://`) → Farcaster (`warpcast`/channel) → Nostr (`npub`, `nevent`) → AP actor → RSS/Atom feed URL → stream URL (later). RSS/Atom **autodiscovery** from an HTML page (`<link rel="alternate">`) is **missing** today; v0 accepts direct feed URLs only (PR 21). The result is one card (`Detected: Bluesky account @x · feed · read-only · [Add]`) or an error: "Not a supported source yet" (listing what is supported) or "Couldn't reach it". Uses the existing `url-guard`.

**Ingest must be parameterized by resolved identity.** Today the pull adapters read fixed lists (`PUBLIC_FIDS` in `lib/farcaster.ts`, `PUBLIC_ATPROTO_SOURCES` in `lib/atproto.ts`, and fixed relays/actors). Resolving a pasted identity must not turn the proxy into an open fetcher: the adapter takes a validated identity (DID, FID, hex pubkey, actor id) and calls only fixed per-protocol endpoint templates (configured AppView, hub, relay set; the actor's own origin for ActivityPub), with per-session rate limits. Every response is bounded before parsing: content-type check, streaming byte caps on both compressed and decompressed size, and structural limits (item count, nesting depth, field lengths). The current ActivityPub adapter calls `response.json()` without a limit, so this applies to actor, outbox, autodiscovery and feed responses alike. `url-guard` checks only the hostname text (`lib/url-guard.ts`), and `fetchPublic` follows redirects (`lib/public-fetch.ts`), so every user-controlled HTTP source (arbitrary ActivityPub actors, direct RSS/Atom URLs and autodiscovery fetches) needs more first: resolve the hostname, reject private, loopback, link-local and metadata addresses, pin the connection to the checked address, and handle redirects manually, re-applying the whole check on every hop with a hop cap (PR 21). Until then, arbitrary actors and feeds are not fetched. *v0 limitation:* until PR 21 lands, paste resolves only to sources already in those lists, and other identities show "Not supported yet".

### 3.9 Mobile picker
Full-screen sheet; tabs at top; selected tray fixed at the bottom.
```
┌──────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
│ ✕  Add to view      Next │   │ ←  s3r.ch · my rooms     │   │ ←  Add 2 sources         │
│ [🔍 Search…      ] [URL] │   │ ☑ # build     ● 12   ›   │   │ Where?                   │
│ Recents Favs Browse Grant│   │ ☐ # design           ›   │   │ (•) One window each      │
│ [Chat][Feed][●Live]      │   │ 🔒 # finance  Request    │   │ ( ) Merge feeds*         │
│ ─────────────────────    │   │                          │   │ ( ) Add to: build-chat ▾ │
│ # build · s3r.ch   ☑     │   │  (tap › = preview sheet) │   │                          │
│ /dev · Farcaster   ☑     │   │                          │   │                          │
│ @alice · Bluesky   ☐     │   │                          │   │                          │
│ ─────────────────────    │   │                          │   │                          │
│ [#build ✕][/dev ✕]  Add 2│   │ [#build ✕]          Add 1│   │          [Add]           │
└──────────────────────────┘   └──────────────────────────┘   └──────────────────────────┘
   Step 2 (picker home)            Browse a server               Step 1 (asked last on mobile)
```
\*"Merge feeds" appears only when every selected source is a feed. Default is always "One window each".

On mobile, step 1 comes *after* selection, because the quick add default covers most cases. **Long-press** any room, post author, or forum channel anywhere in the app → action sheet "Add to view…". Preview is a half-height sheet.

### 3.10 Keyboard and accessibility
- `Ctrl/⌘K` palette: commands "Add source", "New window", "Replace source in focused window", "Go to window N" (`Alt+1..9`).
- Picker: `/` focuses search; arrows move in the tree (ARIA `tree` with `aria-checked` tri-state); `Space` toggles; `→`/`←` expand/collapse; `Enter` confirms; `Esc` closes and returns focus to the invoking control.
- Dialog: `role="dialog"`, focus trap, labelled by the title. A live region announces "2 sources selected" and access states.
- Source color is never the only cue (chip has a text label). Respect reduced motion; thumbnails don't autoplay.
- Drag-and-drop always has a menu equivalent ("Move to…").

### 3.11 Empty, error, offline
- No sources joined: "Nothing to add yet" + actions [Paste a link] [Browse public rooms] [Pull a feed].
- No search match: "No matches in sources you've joined" + [Paste URL].
- Seed peer/WebRTC down: the picker still lists Views, recents and favorites from IndexedDB, plus the held-claim overlay and dest ACL that are already in IndexedDB. Mine posts and rooms are in memory only today (browser Gun runs with `localStorage: false`), so they are **not** promised offline and are not listed after a reload. Network and Granted rows are greyed: "Needs connection". View changes are saved to IndexedDB; nothing else is queued.
- Ingest failure for a provider: that server node shows "Couldn't load · Retry"; other providers are unaffected.
- Window whose source is gone or unshared: "This source is no longer available" [Replace] [Remove].

---

### 3.12 Access requests (v0)

**A request is a hint, never permission.** Access exists only when the owner's client writes owner-signed SociACL grant rows. No request, notification or inbox delivery implies access, and no client caches "allowed" past a cancel: when a cancel merges, the cached state is dropped and Check runs again.

**Storage rule for every signed record in this section.** `s3rch/*` paths are publicly writable, and Gun HAM lets a later write replace a node. A signature check can reject a corrupted winner, but it cannot bring back the valid value that was replaced. So:
- Records are **never stored in a mutable shared slot.** Each record version is written once to an **owner-authenticated namespace**: the Gun SEA user space `~<scoped pub>/…` of the key that signed it, where Gun only accepts writes signed by that key. Other peers cannot overwrite or add entries there.
- **Merkle construction (`merkle-v1`), used for rotation manifests and room checkpoints.** Leaves are `SHA-256(0x00 || key || value)`: for rotations `key` = stream id and `value` = head digest; for checkpoints `key` = node digest and `value` empty. Leaves are sorted by `key` (bytewise) with duplicates removed. Internal nodes are `SHA-256(0x01 || left || right)`. An odd node at any level is promoted unchanged. The empty root is `SHA-256("")`. Inclusion proofs are audit paths as in RFC 6962. Any change to these rules is a new version tag.
- **One canonical encoding.** Every record type (bindings excepted, which are fixed text) is hashed as `H = SHA-256` over RFC 8785 JCS of the record with all signature fields removed; the signature is computed over the same bytes and stored alongside. Absent optional fields are omitted, integers are JSON numbers, and digests are lowercase hex. `prev`, content addresses and committed heads all use this `H`.
- **Record bodies are content-addressed.** Each signed record is stored as a Gun `#` entry keyed by its digest, so not even the signer can replace an accepted body. The signer's authenticated namespace holds only pointers to digests, and revocations and rotations commit to digests (below), so readers can always fetch the committed bodies.
- **Streams are hash chains.** Each record names the digest of the previous head of its stream (`prev`). A writer must reference the current head it has read and does not report success until its record reads back as the new head. If two records share a `prev` (a fork, for example from a stale device or a replayed permissive record), the branch with a restrictive record (unshare, decline, revoke, deny, downgrade) after the fork point wins, unless a later record on the other branch names that restrictive record in its chain.
- Every record carries a signed **monotonic sequence number** and the **binding version** (`bindingCounter`, `H(binding)`) of the key that signed it. The highest valid sequence wins, chosen by the signed number and never by Gun state or wall clock.
- Shared paths hold only **locators**, stored as Gun **content-addressed** entries: the soul contains `#` and the key must equal the hash of the value, which Gun's SEA layer checks on every put (`check.hash` in `gun/sea.js`). Honest peers therefore refuse to overwrite a locator with different content. A locator is a hint; the real data is in the authenticated namespace.
- **Ordering across devices.** The same scoped key can be restored on several devices, so a version is `(seq, deviceId)`, compared by `seq` and then `deviceId`. A device must **sync with the accepted head** of a stream (read the authenticated namespace) before allocating a new `seq`, and allocates `max(seen) + 1`; a device that cannot sync queues visibility and access changes locally and publishes them only after syncing, so a stale counter can never lose to an older record. For visibility and access, a tie between a more restrictive and a less restrictive record (unshare vs share, decline/revoke vs approve) resolves to the more restrictive one.

**Owner key binding (no third-party authority).**
- **Scoped key pairs.** For each source that accepts requests, the owner has a **source-scoped key pair** (SEA `pub`/`epub`, separate from the global mesh pair). Chat authors have a **room-scoped** pair the same way.
- **Binding.** The binding is a fixed plain-text message signed with EIP-191 `personal_sign` by the owner's wallet:
  ```
  s3r.ch key binding v1
  Address: <checksummed owner>
  Role: root | inbox | owner | requester | chat-author
  Source: <canonical SourceRef>   (for root and inbox: the literal "*", meaning wallet-wide)
  SEA pub: <scoped pub>
  SEA epub: <scoped epub>
  Counter: <n>
  Previous: <H(previous binding) or "none">
  Issued At: <ISO 8601>
  Expires At: <ISO 8601>
  Chain ID: <id>
  ```
  For contract wallets, ERC-1271 is checked against the wallet's **current** (latest finalized) state when the binding is first used, and rechecked when the reader refreshes it; a signature cannot prove when it was made, so a caller-chosen historical block is never trusted. If the wallet later stops ratifying a binding (for example after a signer change), the binding is unusable for new records, and its history survives only through the heads committed by a binding the wallet currently ratifies.
  It is **not** a SIWE login message: there is no server nonce or request host, because it is a durable replicated record. Verification is an offline binding verifier that shares only the signature layer with login (`lib/identity/siwe.ts` and viem `verifyMessage`): EOA ecrecover, plus ERC-1271 / EIP-6492 for contract wallets on the stated chain. That code verifies contract wallets on mainnet only today; on other chains bindings are EOA-only, as for login.
- **Binding root and bounded head.** Each wallet binds one long-lived **root key** (role `root`, held only in the PRF envelope, never used for content). The head binding for each source is a pointer chain in `~<root pub>/heads/<role>/<H(SourceRef)>` (keyed by role and source, so an owner key and a chat-author key for the same room never displace each other; wallet locators use the same `(role, SourceRef)` key), which only the root key can write, so arbitrary peers cannot add candidates. Readers resolve the current binding from that head (or from `bindingHash`); the public `s3rch/bindings/…` locator is used only to find the root binding for a wallet the reader has never seen, and that locator holds wallet-signed root bindings only.
- **Finding the binding without unbounded scans.** A SourceRef carries `bindingHash` (§2), so the reader fetches exactly that version from the content-addressed store. Successors are content-addressed children `~<scoped pub>/next/<H(successor)>`, each wallet-signed, so no single mutable slot can be overwritten by a holder of a compromised old key; readers do not rank by claimed counter. The **wallet-signed successor is authoritative from the wallet side**: each binding is also written to the owner's wallet-scoped locator `s3rch/bindings/<owner>/<H(SourceRef)>` as content-addressed entries whose key commits to `(counter, H(binding))`, and every SourceRef shared after a rotation carries the new `bindingHash`. Children under `~<old pub>/next` are only a convenience; a reader that finds no valid successor there within its cap still checks the wallet-scoped locator and the latest `bindingHash` it has seen before accepting the old key, and treats a binding older than a configurable maximum age as needing refresh. The successor is also listed in the new key's namespace (`~<new pub>/prev`) so readers that already know the new key confirm the chain. **Fail closed:** if a reader hits its verification cap in either place without establishing that no newer valid binding exists, it treats the binding as unusable: it does not encrypt requests to it and does not accept new records signed by it until discovery completes. The shared locator `s3rch/bindings/<owner>/<H(SourceRef)>/<H(binding)>` is used only for first discovery, and readers verify at most a configurable number of candidates there.
- **Selection.** Readers take the binding with the **highest validly signed counter** whose `Previous` names the binding it replaces. If two valid bindings share a counter and predecessor (concurrent rotations from two devices), the one with the lower `H(binding)` wins everywhere, and the owner's client, on seeing the fork, publishes `n + 2` naming the winner so the tie does not persist. If that binding has expired or is an empty-key revocation, there is **no active binding** for new records; readers never fall back to a lower counter. **History across expiry:** every binding commits the stream heads of its predecessor (below), and the owner's client publishes a wallet-signed successor before `expiresAt`. If renewal is missed, records under the expired binding are accepted only up to the heads committed by the next wallet-signed binding the owner publishes (which must commit them); until then they are shown as "unverified", never rejected or silently accepted.
- **Key versions in signed records.** Each record names the binding version that signed it. **Every** rotation binding, routine or compromise, is wallet-signed and commits to the accepted heads of every stream signed by the old key (grants, shares, decisions, checkpoints, chat) as a single **Merkle root**, with the per-stream heads in content-addressed, signed manifest chunks, so the binding size does not grow with the number of streams. Old-key records outside those committed prefixes are rejected, whatever sequence or time they claim, **except restrictive records** (cancel, revoke, unshare, deny, downgrade): for a **routine rotation** those are accepted late, because a stale device can rotate before seeing them and an extra restriction is safe. A **compromise revocation freezes** the old key at its committed heads: every later old-key record is rejected, restrictive ones included, so a compromised key cannot keep disabling shares or grants. Rotations are also chained to the previous rotation's root, and a device must sync the aggregate head before rotating. A **revocation for compromise** is wallet-signed and commits to the **accepted head of every record stream** signed by that key (last accepted version and digest per stream: grants, shares, decisions, checkpoints). The same prefix rule applies.
- **Scoped private keys are persisted.** They are stored encrypted in IndexedDB next to the SEA pair and included in the encrypted backup and the PRF envelope export (§5). Scoped pairs are derived from a random **recovery secret** (HKDF over `(secret, role, SourceRef, counter)` with `role` ∈ `owner`, `requester`, `chat-author`, so one role's key never equals another's), stored in the PRF envelope with the SEA pair, so recovery does not depend on any wallet producing the same signature bytes twice (PR 24, PR 29).
- **Relation to [identity.md](identity.md).** The global wallet-to-mesh-key link (`lib/identity/mesh-link.ts`) stays private in IndexedDB, and `lib/users.ts` still rejects signature fields on the user node. A scoped binding is a deliberate, narrower disclosure and does not publish the global mesh `pub`.
  - *Privacy tradeoff:* a source-scoped binding publicly reveals which wallet owns that source, and sources bound to the same wallet can be linked. An owner who wants sources unlinkable can create them from a fresh wallet, which works today. Delegated keys are not supported by the identity code today and are later work.
- **Org sources (later, not v0).** There is no org principal or admin model in the repo today. When one is added, the org owner signs a versioned **admin roster** `{org, epoch, admins[], counter, issuedAt}` with their wallet and stores it like bindings. An admin's action is valid only if the admin's scoped binding verifies **and** the admin was on the roster for the epoch in force at the action's signed sequence.

**Requests are encrypted end to end.**
- **Requester side.** Requesters are wallet users in v0; org principals come later. The requester has one scoped pair per (requester wallet, SourceRef), derived from their recovery secret, and a wallet-signed requester binding for it; both stay **inside** the ciphertext.
- **Canonical request id.** `requestId = H("s3rch-request" || requester wallet || canonical SourceRef)`. It is in the signed request and every signed decision, and groups all versions. It is **never used as a public path**: storage and decision lookups use `lookupId = HMAC(ECDH(requester scoped key, owner scoped epub), requestId)`, which only the two parties can compute. Versions within one id are ordered by `(requester bindingCounter, seq, deviceId)`; `seq` is kept in the requester's backup so it never restarts.
- **Envelope.** The request is SEA-encrypted to the owner's wallet-wide inbox `epub` with an ephemeral pair. The encrypted content is: `requestId`, requester binding, SourceRef, scope, optional message (≤ 280), requester `seq` and `deviceId`, and the requester's signature over all of it.
- **Visible routing data.** Outside the ciphertext there is only a lane tag, the ephemeral `epub`, and the ciphertext. The lane tag is `H(owner inbox epub || "requests" || utcEpochDay)`, where the **inbox key** is one wallet-wide key per owner (role `inbox`), not a per-source key, and `utcEpochDay = floor(unix seconds / 86400)` encoded as a decimal integer. The source is only inside the ciphertext, so the mesh learns at most that some wallet's inbox received a request, not who asked or for which source. The request envelope is encrypted to the inbox `epub` and names the source inside.
- **Storage.** The requester writes each version once in their own namespace: `~<requester scoped pub>/requests/<lookupId>/<seq>.<deviceId>`, so two devices with the same `seq` never share a key. They also put a write-once locator in the owner's lane, `s3rch/rq/<lane>/<H(locator)>`.
- **Per-recipient bodies.** For org sources (later), there is one envelope per admin `epub`, each with its own locator.
- **Transitions.** `pending` and `withdrawn` are requester versions with an increasing `seq`. Replaying an old `pending` cannot replace a newer `withdrawn`, because the highest `seq` wins and older versions cannot be overwritten.

**Decisions.**
- Approve, decline, downgrade and revoke are owner-signed records, written once to `~<owner scoped pub>/decisions/<lookupId>/<seq>.<deviceId>`.
- Each record is encrypted to the requester's scoped `epub`, so only the requester and the owner can read it.
- The signed payload covers `request id, requester, owner, source, scope, effectiveScope, status, decidedAt, seq, bindingCounter, H(binding), v`.
- `effectiveScope` (`read` | `read+post`) is what Check-facing UI uses. A post-only cancel is a `downgrade` decision with `effectiveScope: "read"`.
- **Cooldown.** Measured on the owner's side only: after a decline, the owner's client ignores requester versions for that `requestId` that it **first observes** before the decline's `decidedAt` plus the cooldown, by its own clock. Requester-claimed times are never used. The cooldown length is a per-source setting, not a fixed number.

**Bounds and limits.**
- **One pending request per requester and source:** a single requester namespace per (requester, source), with the highest `seq` winning.
- **Pre-admission by key alone.** A locator's content-address key is `H(value)`, and the resource proof is carried in the value, so the hash itself must meet the proof difficulty: the owner's client discards any lane key without the required leading zero bits **without fetching its value**, and reads at most a configurable number of qualifying keys per lane. Proofless junk costs a string comparison and does not count against any cap.
- **Size first.** A locator and its ciphertext must fit a strict outer serialized-size limit, checked on the raw Gun value before any hashing, proof check or decryption; the decrypted structure has its own field and size limits.
- **Admission, before any cap applies.** Following the inbox write policy in [encrypted-discovery.md](encrypted-discovery.md), a locator on the public first-contact lane must carry a resource proof (proof-of-work sized by an owner setting) bound to the locator hash **and to the lane tag and day**, so a proof cannot be copied into another lane; the owner's client checks it before decrypting. Junk without a valid proof costs a hash check and does not count against the cap.
- **Day lanes and recovery.** Lanes are unordered maps, so there are no cursors: the owner's client keeps an IndexedDB set of processed locator hashes per lane and rescans (or stays subscribed to) every lane within the configurable lookback on each connect, processing any hash not yet in the set. A still-pending requester republishes its locator into the current lane once per lookback period, so a request survives an owner who stays offline longer than the lookback.
- **Reserved capacity.** Requesters who already hold a grant or a prior decision from this owner use a per-pair lane derived by ECDH, which only that pair can compute, so a flooded public lane cannot crowd them out. The cap on the public lane applies only to admitted locators. All limits are enforced by clients. A seed peer may also rate-limit `s3rch/rq/*` writes as an optimization only; nothing trusts it, and the design works with no seed (PR 11, PR 26).
- The canonical signed encodings and an approve→grant helper come from SociACL (SociACL #46).

**Policy per source** (s3r.ch policy, evaluated on the owner's client before any grant is written; SociACL itself has no standing deny):
- `public`: anyone may read and **no request is needed** to read. Requests exist only for `read+post`, which is auto- or manually approved per the owner's setting.
- `members`: members of listed groups auto-approve at a chosen scope. Membership needs a group-membership check ("is accessor a live direct member of group g at time t", hop 1, no nested groups) on the owner's client.
  - SociACL provides this as `checkGroupSee` (`typescript/src/group.js`, documented in SociACL `docs/s3rch-check.md`), and SociACL #46 covers using it for members auto-approve.
  - s3r.ch has its own TypeScript Check (`lib/identity/check.ts`) and does not import the SociACL package. *Dependency:* port `checkGroupSee` into s3r.ch's Check (PR 30). Until the port exists, `members` falls back to the manual queue.
- `manual`: everything goes to the queue.
- **Deny.** An explicit deny is keyed by the **stable `requestId`** (wallet + SourceRef), not by `lookupId`, so rotating either party's key does not escape it. It is an owner-signed record in a per-source deny stream in the owner's root namespace, indexed by `HMAC(K_deny, requestId)` where `K_deny` is derived from the owner's recovery secret and wallet address, not from the root key. Root rotation therefore does not change the index; on recovery-secret rotation (device removal) the client re-indexes every deny head under the new key and commits the old index's heads in the same rotation, `status: "denied"`, with no expiry. It is lifted only by a later owner-signed `undeny` in the same chain, and is checked before any auto rule, for every lookup stream from that wallet. While a deny is the head, the owner's client ignores that requester for that source regardless of cooldown or group rules.
Order: explicit deny, then member/public auto rules, then the manual queue.
- **Withdrawals after approval.** A recheck cannot prove no newer withdrawal exists elsewhere on the mesh. So for every approval the owner's client keeps watching that requester stream for the lookback period; a withdrawal observed later opens a revoke intent and is reconciled like any cancel. The requester's client, if it sees an approval after it withdrew, shows "Withdrawn: access is being removed".
- **Recheck before approving.** Before any automatic or manual approval, the owner's client fetches the requester's authenticated stream for that `lookupId` and approves only if its current head is still the `pending` version being approved; otherwise it re-evaluates. A cancel always wins immediately.

**Auto-approve runs only on the owner's own system while that client is online.** No service issues grants on the owner's behalf. Requests wait ("Waiting for owner to come online") until the owner's client connects and evaluates its lanes.

**Owner approval queue:** an "Access requests" panel with a count badge, reachable from source settings and notifications. Each row shows requester identity (ENS / held claims), source, scope and the decrypted message, with these actions:
- **Approve:** scope is editable. Expiry `until` is always set, defaulting to a configurable per-owner/per-source setting, because `IdentitySeeGrant.until` is required.
- **Decline.**
- **Always approve this group.**

**SociACL mapping:**
- **Grant rows must be owner-signed.** Today `MeshSeeGrant` (`object, accessor, from, until, stated`) and its `GunAclEdge` carry no signature and sit on a publicly writable `s3rch/acl` path, so a peer can forge a grant row.
  - Readers and Check must verify the owner signature, including binding version and `seq`, on every grant and cancel row before accepting it, and treat unsigned rows as absent.
  - *Dependency:* SociACL [#49](https://github.com/FyberLabs/SociACL/issues/49) covers owner-signature verification of public-path see, post and cancel rows and group membership edges; #45 defines the post grant itself. s3r.ch verification is PR 28.
  - *v0 limitation:* until then, mesh grants are hints, and access to content that is not public stays limited as described in §3.4.
- **On approve,** the owner's client writes the see grant (`IdentitySeeGrant{claimId=source object, accessor=requester, from, until}`) and delivers onto `s3rch/granted/<requester>`.
- **Private room content after approval.** `prepareGrantRoomDelivery` delivers only the room node, not its chat. `preparePublishRoomChat` refuses to publish chat for a room that is not public. Views keeps locked content off shared paths.
  - So an approved reader of a **non-public room** gets the room node and metadata only.
  - *v0 limitation:* the window shows "Chat is not available for private rooms yet" instead of content. *Dependency:* encrypted, recipient-specific chat delivery ([encrypted-discovery.md](encrypted-discovery.md)), PR 33.
  - Public rooms and forum channels (via `/api/forum`) are not affected.
- **Post grant.** For `read+post`, the owner's client also writes a **post grant**: a new owner-signed row with the same shape and cancel rule as the see grant (SociACL #45). Check returns `canPost` only if `canSee` also passes. The UI shows read+post only when both grants are live.
- **Post grants are enforced by readers, not only in the UI.** Gun accepts any put, so hiding the composer is not a boundary.
  - *Author chat streams.* Each author's messages in a room form a hash chain (`prev` digest, per-author `seq`). Revoking an author's room-scoped key (for example on device removal in a room owned by someone else) is wallet-signed by the author and commits the accepted head of that chain; readers reject the author's later or forked nodes not in that prefix, without needing the room owner to bump the epoch.
  - *Authenticated author.* `GunChatNode` is unsigned today (`lib/identity/check.ts`). Chat nodes gain a signature by the author's room-scoped key over `(id, room, author, body, ts, seq, prev, epoch, epochCounter, bindingCounter, H(binding), v)`. Readers verify it against the author's room-scoped wallet-signed binding (PR 24, PR 27). *v0 limitation:* until PR 27 lands, mesh chat in rooms that are not public is not authorization-safe, and those rooms are read-only in Views.
  - *Validity is judged by the reader, with no trusted acceptance time.* `ts` is chosen by the sender. When a reader first observes a node, it checks that the author signature verifies and that an owner-signed post grant was live and not cancelled for the node's signed `epoch` and `ts`. A cancel row carries an owner-signed **effective time**.
    - *What a reader can prove offline:* the author signed this exact node, and the owner granted posting for a window and epoch that contain it, with no cancel before it.
    - *What a reader cannot prove:* when the node was really written. A former grant holder can backdate a new message into an old window of an epoch they had access to.
    - *Mitigations:*
      1. Readers who are online drop nodes whose `ts` is far from their own first-observed time (configurable skew).
      2. A cancel row's effective time cuts off everything claimed after it.
      3. The owner signs a **per-room epoch** `{room, epoch, startsAt, counter}` and bumps it on revoke or periodically. Nodes must sign the current epoch, so a removed author cannot produce valid nodes for a new epoch.
      4. The owner acceptance log covers history (below) (PR 31).
    - *History after a reload.* Browser Gun keeps nothing across reloads, so the skew rule cannot help a returning reader.
      - While online, the room owner's client records the **digest of each complete signed node** it accepted, `H(canonical node)`. It periodically signs a checkpoint `{room, epoch, counter, merkleRoot(node digests)}`, written once to `~<owner room-scoped pub>/checkpoints/<counter>.<deviceId>`, together with a signed **digest manifest** (the sorted list of node digests, chunked) so a reader can check a single message without holding the full history.
      - A returning reader accepts a historical node only if its full digest appears in the manifest of a valid checkpoint (manifest chunks are verified against the signed root). A node that reuses an accepted id with a different body has a different digest and is rejected.
      - Nodes newer than the last checkpoint are accepted only if the author's grant is still live now. Otherwise they are shown as "unverified" until a checkpoint covers them. This uses only owner signatures (PR 31).
  - *Enforcement points.* Readers drop nodes that fail these checks (PR 23). A seed peer (`lib/gun-server.ts`) may run the same checks to avoid relaying junk, as an optimization only. Forum posts are already checked server-side by `/api/forum`.
- **Crash-safe transitions.** Approve, downgrade and revoke are written as an owner-signed **intent** record first (target grant state for see and post, and for any revoke of a post grant in a room, the room epoch bump). The owner's client then makes every required write (grant or cancel rows, delivery, decision) idempotently, and on every start reconciles open intents until Check on the owner's side shows the intended grant state and any required new epoch is confirmed. The decision visible to the requester is published last, after that confirmation, so a requester is never told access changed before it did.
- **Cancels.** Check never reads the request. Cancelling either grant is immediate on the destination ACL.
  - Cancelling the **see** grant produces a `revoked` decision ("Access removed").
  - Cancelling only the **post** grant produces a `downgrade` decision with `effectiveScope: "read"`, and the window becomes read-only.
- **Forum channels.** The existing `invite` and `group-add` actions grant see **and post** ([forum.md](forum.md)), so they are used only for `read+post`. Approving `read` needs a new read-only forum action (`invite-read`: see without post) on `POST /api/forum` (PR 20). *v0 limitation:* until then, forum `read` requests stay in the manual queue.

**Cross-network (post-v0, undecided):** a link to another network is a URL plus untrusted hints. The destination network re-checks access and issues its own grant, and cancels stay on the destination's ACL. A grant from one network is never accepted by another. This needs a key binding across networks plus presenter-binding and freshness proofs.

## 4. Composer (in a View)
The composer belongs to a window. Merged feed windows and read-only sources have no composer. In a tabbed window it has a **required target selector** showing the chip of the source it posts to (defaults to the last source the user replied to; replying to a message targets that message's source). Read-only sources can't be selected. One send = one source. There is no "post to all".

## 5. Persistence and sharing
- **Authenticated records are persisted too.** Browser Gun has no durable store, so the client also keeps, in IndexedDB and in the file export, every signed record it relies on (bindings, rotation roots and manifests, grants, decisions, deny heads, epochs, checkpoints and their manifests), plus the accepted heads. After a restore it republishes them to the mesh and can verify access without any peer having kept them.
- **Local store: IndexedDB.** Browser Gun runs with `localStorage: false` (`lib/gun-peer.ts`) and the seed peer's radisk is not durable storage, so the Gun graph is not a save location. Views, recents and favorites live in an origin-scoped IndexedDB store, using the same pattern as the SEA pair store (`lib/identity/idb.ts`).
- **Backup: per-device encrypted records.** On change, each device serializes its Views store with per-View `updatedAt` and a device id, encrypts it with `SEA.encrypt` under a key derived from the user's SEA pair, and stores it as **bounded per-View records**: each View version is encrypted and written as a content-addressed entry, and `~<pub>/s3rch-views/<writerId>` holds only a small signed manifest of current View digests, chunked if needed (not `s3rch/*`). Each device has one stable `writerId`; its tabs serialize all edits and backup writes through the Web Locks API, so a tab always reads the latest local state before writing and edits are never lost. A restore gets a new `writerId`; superseded writer manifests (all Views dominated by another manifest) are tombstoned and pruned, so the number of manifests stays bounded. Each View carries a **version vector** (`deviceId → counter`, bumped on every local edit) instead of relying on wall-clock time. On restore, the client decrypts every device record and merges per View: a version that dominates another wins; deletions are tombstones with their own vector; concurrent versions (neither dominates) are both kept and shown as "Conflicting copies" for the user to pick, never resolved by clock. The resolving write takes the component-wise maximum of all conflicting vectors and then increments its own component, so it dominates every branch it replaced and they do not reappear (PR 2). The backup also holds the encrypted recovery secret for scoped keys (§3.12). **Every restore or reinstall gets a fresh `deviceId`**; imported vectors are kept as ancestry, so a stale export can never overwrite the newer record of the device it came from. **Device removal:** a removed device knew the scoped keys and the wallet-wide root and inbox keys, so removal publishes wallet-signed replacements for the root and inbox keys (new envelopes go only to the new inbox; the old inbox is kept only to migrate already-pending requests), and issues wallet-signed compromise revocations and replacement bindings for every scoped key it held (derived from a new recovery secret), and bumps the epoch of every room the user owns, and commits author chat heads for rooms owned by others, before the device counts as removed (PR 24, PR 31). **Key rotation:** before an old SEA pair is discarded (device revocation or key replacement), the client decrypts every device record and tombstone under the old pair, re-encrypts them under the new pair, and writes them below the new `~<pub>`; the old records are deleted only after the new ones read back (PR 29). The same ciphertext can be exported as a file. A new device needs the SEA pair to decrypt either copy, and today that pair lives only in the old origin's IndexedDB. Recovery uses the planned auth kit: the WebAuthn PRF envelope (v1, ≥2 KEKs: PRF + secondary paper key, see [identity.md](identity.md)) is exported as an encrypted key file together with the Views backup. A new device unlocks it with a synced passkey's PRF or the paper key, restores the SEA pair, then decrypts the Views backup (PR 29). *v0 limitation:* without an exported envelope, Views cannot be restored on a new device. The mesh copy is best-effort replication, not an archive; the file export is the durable backup.
- **Share as template**: an exported JSON of windows + layout + `SourceRef`s only (no messages, no grants). Export sanitizes every URL-bearing component: userinfo and URL fragments are removed (the `network` field is structured data, not a URL, and is kept intact, including `;key=`), and query parameters are dropped unless they are on a per-provider allowlist of known non-secret parameters (default: drop all). The path is kept only when a provider-specific sanitizer recognizes it as non-secret (for example a known public feed path shape); otherwise the source is exported as a placeholder the recipient must fill in (PR 10). The recipient's picker opens it with every row access-checked; anything they can't read shows `Request`.

## 6. Layout (secondary)
Desktop: a resizable split tree. An optional **stage** (largest tile, one stream/voice) sits beside a chat rail (split or tabbed; chat is never merged) and a grid of other windows. Per-window unread badge, focus (`F`, maximize) and pop-out (separate browser window). Video tiles: at most 4 playing at once to start with, extras paused with a poster.
```
┌ Views ▾ "Dev + streams" ─────────────────────────────── [+ Add] ⌘K ┐
│ ┌──────── Stage (stream) ───────────┐ ┌ #build · s3r.ch›0xA1 3 ──┐  │
│ │                                   │ │ 0x9c…  deploy green      │  │
│ │            video                  │ │ [message #build…]        │  │
│ └───────────────────────────────────┘ ├ /dev · Farcaster ───────┤  │
│ ┌ News (merged feeds) ┐ ┌──── + ────┐ │ alice  new release       │  │
└────────────────────────────────────────────────────────────────────────┘
```
Mobile: one stage with a swipeable window strip; chat as a bottom sheet; PiP for video.
```
┌──────────────────────┐
│ Stage / active window │
├──────────────────────┤
│ ◀ build · News · + ▶ │  (swipe strip, unread dots)
├──────────────────────┤
│ ▔ chat sheet (drag)  │
└──────────────────────┘
```

## 7. Moderation, identity, limits
- Author display is per source: wallet/ENS for s3r.ch, handle for ATProto/Farcaster (resolved from the stored DID/FID at display time), npub for Nostr, plus a provider mark. Mute/hide is local to the View; owner moderation stays in the source.
- Limits (starting values): 12 windows per View, 8 sources per merged window, 4 live video tiles, 1 voice room active.

## 8. Backend dependencies (revised)

| Need | Status |
| --- | --- |
| Rooms, chat, presence, forum read/post, Check, grant inbox | Exists |
| Pull adapters (ATProto, Farcaster, Nostr, AP, RSS) | Exists (read-only feeds, not chat-shaped) |
| `SourceRef {network, owner, source}` + adapters + unified row shape | Missing, client-side lib |
| Origin tree: other s3r.ch networks (one isolated Gun instance per network), org principals | Missing (orgs exist only as forum groups) (PR 13) |
| Picker search v0: local index + mesh tag/public discovery, type-scoped | Missing; Discover gives partial tag browse |
| Access request object, per-source policy (public/members/manual), owner queue | Missing |
| Client-side auto-approve on owner/org-admin system (evaluate pending queue on connect) | Missing, client-side |
| Other networks: add by URL + permitted key | Missing (v0 assumption); directory later; cross-network requests/grants planned post-v0 (security-heavy) |
| Real search function (post-v0) | Missing |
| Server-side permission-graph search (post-v0) | SociACL [#47](https://github.com/FyberLabs/SociACL/issues/47), blocked on SociACL #31 (group search tokens); v0 filters through Check in the client |
| SociACL [#45](https://github.com/FyberLabs/SociACL/issues/45): owner-signed post grant (see-grant shape, same cancel rule); `canPost` requires `canSee` | Missing (SociACL repo) |
| SociACL [#46](https://github.com/FyberLabs/SociACL/issues/46): canonical signed request encoding + approve→grant helper | Missing (SociACL repo) |
| SEA ECDH request body encryption (owner / org admin keys) + status signature verification | Missing, client-side |
| Decline cooldown setting, default grant `until` setting, deterministic request keys | Missing (PR 11) |
| URL resolver | Partly (`url-guard`); missing as one module (PR 8) |
| RSS/Atom autodiscovery from HTML pages | Missing (PR 21) |
| Ingest parameterized by validated identity (fixed endpoint templates, rate limits) | Missing; adapters read fixed lists today (PR 21) |
| Per-user outbound credential binding (Bluesky, Farcaster) | Missing; outbound uses deployment-wide env credentials (PR 22) |
| Post-grant enforcement by readers (author signature + owner-signed grant/cancel rows) | Missing (PR 23) |
| Owner-signed, source-scoped key bindings (EIP-4361/EIP-191, ERC-1271 on mainnet), counter + expiry | Missing; reuses SIWE verification code (PR 24) |
| Public visibility semantics in a Check wrapper | Missing (PR 25) |
| Read-only forum invite (`invite-read`) | Missing (PR 20) |
| Encrypted content for non-public sources ([encrypted-discovery.md](encrypted-discovery.md)) | Design only; separate track. v0 keeps locked content off shared paths |
| Group-membership check in s3r.ch Check (port of SociACL `checkGroupSee`) | Exists in SociACL; missing in s3r.ch (PR 30). `members` falls back to manual until ported |
| Per-room owner-signed epoch + cancel rows with effective time | Missing (PR 31) |
| Request namespace bounds (key check, caps, client-enforced limits; optional seed limits as optimization) | Missing (PR 11, PR 26) |
| Delegated binding keys | Missing; later work |
| First-contact resource proof + per-pair lanes for requests | Missing (PR 11) |
| Checkpoint digest manifests | Missing (PR 31) |
| Owner-authenticated record storage (`~<scoped pub>` namespaces, signed seq + binding version, write-once locators) | Missing (PR 11, PR 24) |
| Encrypted request envelopes on blinded lanes | Missing (PR 11) |
| Scoped private key persistence and backup | Missing (PR 24, PR 29) |
| SSRF-safe fetch: DNS resolve + address pinning + per-redirect checks | Missing; `url-guard` checks hostname text only (PR 21) |
| Encrypted recipient-specific chat delivery for private rooms | Missing; `prepareGrantRoomDelivery` delivers the room node only (PR 33) |
| Owner-signed share/unshare for public nodes | Missing (PR 24, PR 25) |
| Owner acceptance log checkpoints for room history | Missing (PR 31) |
| Signed presence heartbeats + see check | Missing; `GunPresenceNode` unsigned (PR 32) |
| Org admin roster (org-owner-signed, versioned) | Missing; later work with org principals |
| Template export URL sanitizing (userinfo, query allowlist) | Missing (PR 10) |
| Signed `GunChatNode` (author mesh-key signature) | Missing; chat nodes are unsigned today (PR 27) |
| Owner-signed grant rows (see, post, cancel, group edges) + verification before accept | Missing. SociACL [#49](https://github.com/FyberLabs/SociACL/issues/49) (PR 28) |
| Encrypted SEA key export / PRF envelope recovery for new devices | PRF wrap exists; export and restore flow missing (PR 29) |
| Owner-signed decision record + per-recipient request bodies | Missing (PR 11) |
| Join / membership action for rooms | Missing; deferred to bot-plane room membership (ROADMAP item 1) |
| Views storage: IndexedDB + SEA-encrypted backup (mesh copy + file export) | IndexedDB and SEA helpers exist; Views schema missing (PR 2) |
| Streams / voice / meetings (WebRTC + Panopticon TURN; relay/SFU for >few viewers) | Missing (ROADMAP item 3). TURN allocate exists |
| Discord / Matrix / Twitch / YouTube adapters | Missing; Discord fits under the bot-plane adapter work |
| Live state for streams ("live now", thumbnails) | Missing |

## 9. SociACL dependencies

| SociACL issue | Unblocks s3r.ch PRs | Phase |
| --- | --- | --- |
| [#45](https://github.com/FyberLabs/SociACL/issues/45) Owner-signed post grant (read+post) | 4 (inline canPost state), 5 (targeted composer posting), 11, 12, 23, 28, 31 | v0 |
| [#46](https://github.com/FyberLabs/SociACL/issues/46) Signed access requests + approve-to-grant helper; members auto-approve via `checkGroupSee` | 11, 12, 30 | v0 |
| [#49](https://github.com/FyberLabs/SociACL/issues/49) Owner-signature verification of public-path see, post and cancel rows and group membership edges | 28, 23 | v0 |
| [#47](https://github.com/FyberLabs/SociACL/issues/47) Permission-filtered search | 17 | post-v0, blocked on SociACL #31 |
| [#48](https://github.com/FyberLabs/SociACL/issues/48) Cross-network requests and grants (security design) | 19 | post-v0 |

Until #45 lands, v0 windows show read-only for s3r.ch sources the user does not own.

## 10. Suggested PR split
1. `SourceRef` + source adapters (room, forum, feed) + unified row type + Window schema enforcing `merged ⇒ kind feed`, with tests.
2. Views schema + IndexedDB store + SEA-encrypted backup (user-graph copy and file export) + recents/favorites.
3. Picker v0: Recents / Favorites / Browse tree, multi-select, kind inference, quick add (desktop dialog).
4. Inline Check states + pending window state.
5. Split-window decorators (color, label, origin badge) + merged feed window (validation rejects merged non-feed windows, with a test) + targeted composer.
6. View route `/views/[id]` + split layout + unread + focus.
7. Swap/move/replace + undo stack + drag-and-drop with menu equivalents.
8. URL/invite resolver + paste entry + command palette.
9. Mobile full-screen picker sheet + long-press "Add to view" + mobile layout.
10. Template export/import with URL credential stripping.
11. Access requests: owner-authenticated storage, encrypted request envelopes on blinded lanes, encrypted request object + signed status + limits/cooldown + requester form + owner queue + grant-on-approve (manual policy). Depends on SociACL #45 (post grant) and #46 (request encoding + helper).
12. Request policies: public / group / org auto-approve, evaluated on the owner's or an org admin's online client; pending queue on connect.
13. Origin tree (one isolated Gun instance per network): org owners + other s3r.ch networks added by URL + permitted key; `SourceRef` network field wired through.
14. Search v0: type-scoped joined + public/tag mesh search (client index + live discovery).
15. Later: stream/voice windows on top of ROADMAP item 3; external chat adapters; merged chat via @-reply addressing (future).
v0 additions :
20. Forum `invite-read` action (see without post) on `POST /api/forum`.
21. Parameterized ingest by validated identity + RSS/Atom autodiscovery.
22. Per-user outbound credential binding for Bluesky / Farcaster.
23. Post-grant enforcement by readers (author signature + owner-signed grant/cancel rows). Depends on SociACL #45, #49 and PR 27.
24. Owner-signed, source/room-scoped key bindings: EIP-4361/EIP-191 signing and verification (reusing `lib/identity/siwe.ts`), monotonic counter, expiry, admin bindings.
25. Public visibility Check wrapper (requires owner-signed share/unshare from PR 24).
26. Client-enforced request rate limits and caps; optional seed write limits as a non-trust optimization.
27. Signed `GunChatNode` (author room-scoped key, includes room epoch) + reader verification. Depends on PR 24; prerequisite for PR 23.
28. Owner-signed grant row verification in Check and readers. Depends on SociACL #49 (and #45 for post rows).
29. SEA key export / PRF envelope recovery bundled with the Views backup; backup migration on SEA key rotation.
30. Port SociACL `checkGroupSee` into s3r.ch Check (members auto-approve).
31. Per-room owner-signed epoch, owner-signed cancel rows with effective time, and owner acceptance log checkpoints.
32. Signed presence heartbeats; presence counts and Live now use only verified heartbeats.
33. Encrypted, recipient-specific chat delivery for private rooms (per [encrypted-discovery.md](encrypted-discovery.md)).

Post-v0:
16. Real search function.
17. Server-side permission-graph search (SociACL #47, blocked on SociACL #31).
18. Network directory.
19. Cross-network access (SociACL #48, security design first): destination re-checks and issues its own grants; cross-network key binding, presenter binding and freshness proofs.

## 11. Open items
None for v0. Cross-network requests and grants need their own security design before implementation.
