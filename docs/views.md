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
// network: "s3rch:" + scheme + "://" + host + ":" + port + "#" + keyFingerprint  (this or another deployment;
//          scheme, host and explicit port are kept, keyFingerprint = SHA-256 of the permitted key, so a changed key
//          or scheme is a different network and is shown as such) | "atproto" | "farcaster" | "nostr" | "activitypub" | "rss" | ...
// owner:   stable id: checksummed wallet / org id / DID / FID / Nostr hex pubkey / actor id URL / feed origin (never a handle)
// source:  provider-local id (room id, forum channel, feed URL, stream id)
type SourceRef = { network: string; owner: string; source: string; kind: "chat"|"forum"|"feed"|"stream"|"voice"; v: 1 };
// canonical string: "sr1:" + pct(network) + "/" + pct(owner) + "/" + pct(source) + "/" + kind
//   pct() = percent-encode every byte outside RFC 3986 unreserved (A-Z a-z 0-9 - . _ ~), so "/" and ":" inside
//   components are always escaped and the encoding is injective. Parsing splits on "/" then decodes; a component
//   that is empty or re-encodes differently is rejected.
type Window = { id: string; kind: "chat"|"forum"|"feed"|"stream"|"voice"; sources: SourceRef[]; mode: "single"|"tabs"|"merged"; label?: string; colorBy?: Record<string,string> };
// Invariants, checked on every window on create, load and import (PR 1 schema, PR 5 validation, with tests):
//   - every source.kind === window.kind
//   - mode "single": exactly 1 source (the only mode for stream and voice)
//   - mode "tabs":   2..N sources, kind chat | forum | feed
//   - mode "merged": 2..8 sources, kind feed only
//   An invalid window is dropped from the loaded View with a visible notice; it is never repaired silently.
// LayoutTree = { type: "leaf"; windowId: string } | { type: "split"; dir: "row"|"col"; sizes: number[]; children: LayoutTree[] }
// After dropping windows, the layout is re-validated: leaves must reference unique surviving window ids,
// splits with 0 children are removed, splits with 1 child collapse into it, sizes are renormalized, and
// surviving windows without a leaf are appended. If the result is still invalid, the default grid is used (PR 1).
type View = { id: string; title: string; windows: Window[]; layout: LayoutTree; v: 1 };
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
  - *Public visibility (defined first):* `checkSee` today allows only the owner or a live grant (`lib/identity/check.ts`); it has no notion of public. For Views, **public** means: the object node is on a shared path (`s3rch/rooms`, `s3rch/items`; forum channels are never public) through explicit share-into-mesh, carries no unshare marker, and the share (and any unshare tombstone) is **signed by the owner** with the owner's source-scoped binding key (PR 24). `GunRoomNode` and `GunFeedNode` carry no owner signature today, so any peer could forge a share or tombstone naming another wallet. Unsigned shared nodes are never returned as `public`; *v0 limitation:* until PR 24 and PR 25 land, they are shown with the claimed owner marked "unverified" and are not grouped under that owner. Public content is plaintext by design. A Check wrapper in s3r.ch returns `{allowed, reason: "public"}` for such nodes and defers to `checkSee` for everything else (PR 25).
  - *v0 mechanism (decided):* a browser-side index of joined sources plus live mesh tag and public-room discovery. The searcher's client filters every candidate through Check before showing content; locked hits show metadata only. No new service; results only cover peers reachable right now. Hop depth is 1, so there are no friend-of-friend walks.
  - *Later (post-v0):* server-side search over the permission graph. It is blocked on an open SociACL question about group search tokens.
- **Browse**: origin tree **Networks → users/orgs → sources**. Networks are grouped as *This network*, *Other s3r.ch networks* (added by URL; read through that deployment's seed peer) and *Protocols*. Lazily expanded. Each source gets a checkbox; a server gets a tri-state "select all visible". Selections stay across tabs and filters.
- **Filters**: by kind; **Live now** (signed presence heartbeat within TTL from a signer with live see permission, or a stream marked live); **Unread** (local cursor).
- **Previews** go through Check exactly like reads. Check-filtering is a display rule, not confidentiality: any peer that replicates a plaintext node can read it. Content of non-public sources must therefore be encrypted on the graph as specified in [encrypted-discovery.md](encrypted-discovery.md). *v0 limitation:* until that design ships, Views never puts locked content on shared paths, Mine stays local, and grant-delivered rows (plaintext in `s3rch/granted/…` today, see the known issue in that doc) are treated as visible to the mesh. A locked source shows **no content**, only metadata the user can already see (name, owner, kind). Readable previews only show data that already exists: last 2–3 messages (room chat / forum read / pulled items), presence count (rooms only; counts only signed heartbeats whose signer has live see permission. `GunPresenceNode` is unsigned today, so *v0 limitation:* presence counts and Live now are hidden until signed heartbeats land, PR 32), live thumbnail (streams, later). Fields with no data are hidden, never shown as "0" or as placeholders.

### 3.5 One window, several origins?

- **Feeds: yes.** A merged feed window orders items by `ts`. Every row carries a source chip (color, label, origin badge). The header lists the sources as removable chips. Starting cap: 8 sources.
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

**Ingest must be parameterized by resolved identity.** Today the pull adapters read fixed lists (`PUBLIC_FIDS` in `lib/farcaster.ts`, `PUBLIC_ATPROTO_SOURCES` in `lib/atproto.ts`, and fixed relays/actors). Resolving a pasted identity must not turn the proxy into an open fetcher: the adapter takes a validated identity (DID, FID, hex pubkey, actor id) and calls only fixed per-protocol endpoint templates (configured AppView, hub, relay set; the actor's own origin for ActivityPub through `url-guard`), with per-session rate limits. *v0 limitation:* until PR 21 lands, paste resolves only to sources already in those lists, and other identities show "Not supported yet".

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

**A request is a hint, never permission.** Access exists only when the owner's (or an org admin's) client writes SociACL grant rows. No request, notification or inbox delivery implies access, and no client caches "allowed" past a cancel: when a cancel merges, the cached state is dropped and Check runs again.

**Request object** (Gun, `s3rch/requests/<owner>/<id>`, where `id = H("s3rch-request" || requester || canonical SourceRef)`. The key is deterministic per requester and source, so two tabs or devices write the same slot and the one-pending rule converges under HAM):
```ts
type AccessRequest = {
  id: string; requester: string;            // checksummed wallet only in v0; org principals come later
  source: string;                           // canonical SourceRef
  scope: "read" | "read+post";
  // message bodies live in child nodes, one per recipient key, so copies never compete under HAM:
  //   s3rch/requests/<owner>/<id>/body/<H(recipient epub)> = SEA ECDH ciphertext of {message?: ≤ 280}
  //   one entry for the owner; for org sources one entry per admin epub
  status: "pending" | "approved" | "declined" | "withdrawn" | "revoked";
  statusSig: string;                        // signature by an allowed signer over the canonical encoding of
                                            // (id, requester, owner, source, scope, status, ts, v)
  ts: number; decidedBy?: string; decidedAt?: number; v: 1;
};
```
- **Signatures cover the whole request.** A status change signs requester, owner, source and scope as well as id, status and ts, so an approval cannot be replayed onto a changed request. Readers recompute the encoding from the stored fields and drop rows whose fields do not match the signature.
- **Bounded namespace.** `s3rch/requests/<owner>` accepts only keys equal to `H("s3rch-request" || requester || SourceRef)` for a requester wallet whose signature verifies; readers and the owner's client ignore unsigned, invalid or mismatched entries without further work. Each owner client processes at most a configurable number of pending requests per requester and in total, oldest first. These limits are enforced by clients. A seed peer may also apply per-session and per-owner write limits on this path and drop puts that fail the key or signature check, but only as an optimization: no client trusts the seed, and the design works with no seed at all (PR 11, PR 26).
- **Requesters are wallet users in v0.** Only wallet principals have SEA signing and encryption keys, can sign `withdrawn`, and have a `s3rch/granted/<wallet>` inbox. Org principals as requesters come later.
- **Owner key binding (no third-party authority).** The requester needs a key for the owner (or each admin) that is provably controlled by the owner's wallet. s3r.ch runs mostly on GunDB with no central party, so no seed peer or service vouches for keys.
  - **Self-published, wallet-signed, scoped.** For each source that accepts requests, the owner generates a **source-scoped request key pair** (SEA `pub`/`epub`, separate from their global mesh pair) and publishes a binding as an immutable, content-addressed version at `s3rch/bindings/<owner>/<H(SourceRef)>/<counter>/<H(binding)>`; no version is ever overwritten, so an invalid write from another peer cannot erase the latest valid binding. Readers list the versions, verify each, and keep the valid one with the highest counter. The binding is: an EIP-4361-style message (EIP-191 `personal_sign`), with domain, owner address, SourceRef, scoped `pub`, scoped `epub`, `issuedAt`, `expiresAt` and a monotonic `counter`, signed by the owner's wallet. Any client verifies it with the same code path as SIWE login (`lib/identity/siwe.ts`): EOA ecrecover, plus ERC-1271 / EIP-6492 for contract wallets. That code verifies contract wallets on mainnet only today; on other chains bindings are EOA-only, as for login.
  - **Replacement and expiry.** The binding with the highest valid `counter` that has not expired wins; a binding signed with a lower counter is ignored, so old bindings cannot be replayed. Rotating the key or revoking the binding means signing a higher counter (a revocation has empty keys).
  - **Relation to [identity.md](identity.md).** The global wallet-to-mesh-key link (`lib/identity/mesh-link.ts`) stays private in IndexedDB, and `lib/users.ts` still rejects signature fields on the user node. The scoped binding is a deliberate, narrower disclosure and does not publish the global mesh `pub`. *Privacy tradeoff:* a source-scoped binding publicly reveals which wallet owns that source, and a reader can link all sources whose bindings name the same wallet. An owner who wants sources unlinkable can create them from a fresh wallet, which works today because any wallet can sign in. A delegated key (one wallet authorizing another key to sign bindings) is not supported by s3r.ch's identity code today, so it is listed as later work.
  - **Org sources (later, not v0):** there is no org principal or admin model in the repo today. When added, the org owner signs a versioned **admin roster** `{org, epoch, admins[], counter, issuedAt}` with the org owner's wallet, stored as immutable versions like bindings. An admin's approval, decision or grant is valid only if the admin's own scoped binding verifies **and** the admin was on the roster for the epoch in force at the decision's signed time. A roster that is unsigned or has a lower counter is ignored.
  - **Chat authors** use the same mechanism, scoped to the room: an author publishes a room-scoped binding for the key that signs their chat nodes.
  - Requests use the scoped `epub` to encrypt message bodies and the requester's own scoped binding to sign. Until PR 24 lands, requests carry no message body.
- **Who may write status:** `withdrawn` is signed by the requester. `approved` and `declined` are signed by the owner or an org admin. `revoked` is signed by the owner or an admin and is set when the grant is cancelled. Nobody else may write status, and readers verify `statusSig` against the allowed signer set and drop anything else.
- The canonical signed encoding and an approve→grant helper come from SociACL (SociACL #46).
- **Limits:** one pending request per requester per source, enforced by the deterministic key above. After a decline, a cooldown applies before that requester can ask again; its length is a setting per source/owner, not a fixed number.
- **Decisions live in an owner-controlled record.** Approve, decline and revoke are also written to `s3rch/request-decisions/<owner>/<id>/<decidedAt>` as append-only entries signed by the owner or an admin The signature covers every field used for identity or ordering: `id, requester, owner, source, scope, status, decidedAt, decidedBy, v`, and the entry key must equal the signed `decidedAt`. Readers ignore entries without a valid signature or with a key that does not match, and order only by the signed `decidedAt`. The requester can rewrite their own `pending` slot, but the owner's client and every reader evaluate it against the latest signed decision: a `pending` written inside the cooldown after a signed decline is ignored (PR 11).

**Policy per source** (s3r.ch policy, evaluated on the owner's or admin's client before any grant is written; SociACL itself has no standing deny):
- `public`: anyone may read and **no request is needed** to read. Requests exist only for `read+post`, which is auto- or manually approved per the owner's setting.
- `members`: members of listed groups/orgs auto-approve at a chosen scope. Membership needs a group-membership check ("is accessor a live direct member of group g at time t", hop 1, no nested groups) on the owner's client. SociACL provides this as `checkGroupSee` (`typescript/src/group.js`, documented in SociACL `docs/s3rch-check.md`), and SociACL #46 covers using it for members auto-approve. s3r.ch has its own TypeScript Check (`lib/identity/check.ts`) and does not import the SociACL package, so *dependency:* port `checkGroupSee` into s3r.ch's Check (PR 30). Members auto-approve works in v0 once the port exists; until then `members` policies fall back to the manual queue.
- `manual`: everything goes to the queue.
Order: explicit deny (s3r.ch policy), then member/public auto rules, then the manual queue. A cancel always wins immediately.

**Auto-approve runs only on the owner's own system, or an org admin's for org sources, while that client is online.** No service issues grants on the owner's behalf. Requests wait in `pending` ("Waiting for owner to come online") until such a client connects and evaluates the queue.

**Owner approval queue:** an "Access requests" panel with a count badge, reachable from source settings and notifications. Each row shows requester identity (ENS / held claims), source, scope and the decrypted message, with **Approve** (scope editable; expiry `until` is always set, defaulting to a configurable per-owner/per-source setting, because `IdentitySeeGrant.until` is required), **Decline**, and **Always approve this group**.

**SociACL mapping:**
- **Grant rows must be owner-signed.** Today `MeshSeeGrant` (`object, accessor, from, until, stated`) and its `GunAclEdge` carry no signature, on a publicly writable `s3rch/acl` path, so a peer can forge a grant row. Readers and Check must verify an owner (or admin) signature on every grant row before accepting it, and treat unsigned rows as absent. *Dependency:* SociACL [#49](https://github.com/FyberLabs/SociACL/issues/49) covers owner-signature verification of public-path see, post and cancel rows and group membership edges; #45 defines the post grant itself. s3r.ch verification is PR 28. *v0 limitation:* until then, mesh grants are hints and access to content that is not public stays limited as described in §3.4.
- On approve, the owner's client writes the see grant (`IdentitySeeGrant{claimId=source object, accessor=requester, from, until}`) and delivers onto `s3rch/granted/<requester>`.
- For `read+post` it also writes a **post grant**: a new owner-signed row with the same shape and cancel rule as the see grant (SociACL #45). Check returns `canPost` only if `canSee` also passes. The UI shows read+post only when both grants are live.
- **Post grants are enforced when writes are accepted, not only in the UI.** Gun accepts any put, so hiding the composer is not a boundary. This needs three things:
  - *Authenticated author.* `GunChatNode` is unsigned today (`lib/identity/check.ts`), so a claimed `author` proves nothing. Chat nodes gain a SEA signature by the author's mesh key over (id, room, author, body, ts, v), and readers verify it against the author's room-scoped wallet-signed binding (PR 24, PR 27). *v0 limitation:* until PR 27 lands, mesh chat in rooms that are not public is not authorization-safe, and Views shows those rooms read-only.
  - *Validity judged by the reader, with no trusted acceptance time.* `ts` is chosen by the sender. Each reader checks, when it first observes a node, that the author signature verifies and that an owner-signed post grant (SociACL #45, signature verification #49) was live and not cancelled. Grant and cancel rows are owner-signed with validity windows; a cancel row carries an owner-signed **effective time**.
    - *What a reader can prove offline:* the author wrote this exact body, and the owner granted posting for a window that contains the node's claimed `ts` and had not cancelled before that time.
    - *What a reader cannot prove:* when the node was really written. Without a trusted clock, a former grant holder can backdate a new message into an old grant window. Local first-observed time limits this only for readers who were online.
    - *Mitigations:* (1) readers drop nodes whose `ts` is far from their own first-observed time (configurable skew); (2) a cancel row's effective time cuts off everything claimed after it; (3) the owner signs a **per-room epoch** `{room, epoch, startsAt, counter}`, and authors must include the current epoch in the signed node, so after the owner bumps the epoch (on revoke or periodically) a removed author cannot produce valid nodes for the new epoch, and backdating is limited to the epoch that was live when they had access (PR 31).
    - *History after a reload.* Browser Gun keeps nothing across reloads, so a returning reader first-observes all history "now" and the skew rule cannot tell genuine old messages from new backdated ones. Instead, the room owner's client signs an **owner acceptance log**: while online it records the message ids it accepted and periodically signs a checkpoint `{room, epoch, counter, H(sorted accepted ids)}` with the owner's binding key, stored as immutable versions. A returning reader accepts historical messages covered by a valid owner checkpoint. Messages newer than the last checkpoint are accepted only if their author's grant is still live now; otherwise they are shown as "unverified" until a checkpoint covers them, and never counted as from a current member. This uses only owner signatures, with no seed authority (PR 31).
  - *Enforcement points.* Readers drop nodes that fail these checks (PR 23). A seed peer (`lib/gun-server.ts`) may run the same checks to avoid relaying junk, as an optimization only; correctness never depends on it. Forum posts are already checked server-side by `/api/forum`.
- Check never reads the request. Cancelling either grant is immediate on the destination ACL. Cancelling the **see** grant marks the request `revoked` ("Access removed"). Cancelling only the **post** grant is a downgrade: the request stays `approved` with `effectiveScope: "read"` (a signed decision entry), and the window shows read-only.
- Forum channels: the existing `invite` and `group-add` actions grant see **and post** ([forum.md](forum.md)), so they are used only for `read+post`. Approving `read` needs a new read-only forum action (`invite-read`: see without post) on `POST /api/forum` (PR 20). *v0 limitation:* until then, forum `read` requests stay in the manual queue and cannot be approved as read-only.

**Cross-network (post-v0, undecided):** a link to another network is a URL plus untrusted hints. The destination network re-checks access and issues its own grant, and cancels stay on the destination's ACL. A grant from one network is never accepted by another. This needs a key binding across networks plus presenter-binding and freshness proofs.

## 4. Composer (in a View)
The composer belongs to a window. Merged feed windows and read-only sources have no composer. In a tabbed window it has a **required target selector** showing the chip of the source it posts to (defaults to the last source the user replied to; replying to a message targets that message's source). Read-only sources can't be selected. One send = one source. There is no "post to all".

## 5. Persistence and sharing
- **Local store: IndexedDB.** Browser Gun runs with `localStorage: false` (`lib/gun-peer.ts`) and the seed peer's radisk is not durable storage, so the Gun graph is not a save location. Views, recents and favorites live in an origin-scoped IndexedDB store, using the same pattern as the SEA pair store (`lib/identity/idb.ts`).
- **Backup: per-device encrypted records.** On change, each device serializes its Views store with per-View `updatedAt` and a device id, encrypts it with `SEA.encrypt` under a key derived from the user's SEA pair, and puts it at `~<pub>/s3rch-views/<deviceId>` (not `s3rch/*`), so devices never overwrite each other. On restore, the client decrypts every device record and merges per View: newest `updatedAt` wins, deletions are kept as tombstones, ties break by device id (PR 2). **Key rotation:** before an old SEA pair is discarded (device revocation or key replacement), the client decrypts every device record and tombstone under the old pair, re-encrypts them under the new pair, and writes them below the new `~<pub>`; the old records are deleted only after the new ones read back (PR 29). The same ciphertext can be exported as a file. A new device needs the SEA pair to decrypt either copy, and today that pair lives only in the old origin's IndexedDB. Recovery uses the planned auth kit: the WebAuthn PRF envelope (v1, ≥2 KEKs: PRF + secondary paper key, see [identity.md](identity.md)) is exported as an encrypted key file together with the Views backup. A new device unlocks it with a synced passkey's PRF or the paper key, restores the SEA pair, then decrypts the Views backup (PR 29). *v0 limitation:* without an exported envelope, Views cannot be restored on a new device. The mesh copy is best-effort replication, not an archive; the file export is the durable backup.
- **Share as template**: an exported JSON of windows + layout + `SourceRef`s only (no messages, no grants). Export sanitizes every URL-bearing component: userinfo is removed, and query parameters are dropped unless they are on a per-provider allowlist of known non-secret parameters (default: drop all). Sources whose URL cannot be made credential-free are exported as a placeholder the recipient must fill in (PR 10). The recipient's picker opens it with every row access-checked; anything they can't read shows `Request`.

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
11. Access requests: encrypted request object + signed status + limits/cooldown + requester form + owner queue + grant-on-approve (manual policy). Depends on SociACL #45 (post grant) and #46 (request encoding + helper).
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

Post-v0:
16. Real search function.
17. Server-side permission-graph search (SociACL #47, blocked on SociACL #31).
18. Network directory.
19. Cross-network access (SociACL #48, security design first): destination re-checks and issues its own grants; cross-network key binding, presenter binding and freshness proofs.

## 11. Open items
None for v0. Cross-network requests and grants need their own security design before implementation.
