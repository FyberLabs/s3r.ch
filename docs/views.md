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
  - **Network**: this s3r.ch deployment, another s3r.ch deployment (separate network with its own seed peer; *v0 assumption:* added by URL plus a permitted key, with a directory coming later; cross-network requests and grants are a later goal, not v0, because doing them securely needs substantial work), or an open protocol (ATProto, Farcaster, Nostr, ActivityPub, RSS, later Matrix etc.).
  - **Owner**: a user or org inside that network (wallet/org id on s3r.ch, DID/handle on ATProto, FID, npub, actor, site).
  - **Source**: a channel/feed/stream owned by that owner.
  Servers are for browsing; a View stores only full source references.
- **Window**: one tile in a View. It has a `kind` and **1..N sources**.
- **View**: a saved, named set of windows plus layout. Stored in the user's own Gun graph, private.

```ts
// network: "s3rch:<host>" (this or another deployment) | "atproto" | "farcaster" | "nostr" | "activitypub" | "rss" | ...
// owner:   checksummed wallet / org id / DID / FID / npub / actor URL / site origin
// source:  provider-local id (room id, forum channel, feed URL, stream id)
type SourceRef = { network: string; owner: string; source: string; kind: "chat"|"forum"|"feed"|"stream"|"voice"; v: 1 };
// canonical string: <network>/<owner>/<source>, e.g. s3rch:s3r.ch/0xA1…ff/s3rch:room:…
type Window = { id: string; kind: "chat"|"forum"|"feed"|"stream"|"voice"; sources: SourceRef[]; mode: "single"|"tabs"|"merged"; label?: string; colorBy?: Record<string,string> };
// Invariant: mode === "merged" only when kind === "feed" (and every source is a feed).
// Enforced in schema + validation (PR 1, PR 5); a test rejects merged chat/forum/stream/voice windows.
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
- **Recents**: the last 20 sources the user opened or added, from the local Gun graph. **Favorites**: starred sources, private.
- **Search** covers two scopes in one result list, both filtered by the selected type (chat, forum, feed, stream, voice):
  - **Joined**: owned, shared, granted, pulled and favorite sources. Searched in the browser.
  - **Public**: public rooms and sources plus tag matches on the shared mesh, including other networks the user has added.
  Results are grouped by origin and carry an access badge.
  - *Constraint:* the repo says there is no search API, and Discover is "not search".
  - *v0 mechanism (decided):* a browser-side index of joined sources plus live mesh tag and public-room discovery. The searcher's client filters every candidate through Check before showing content; locked hits show metadata only. No new service; results only cover peers reachable right now. Hop depth is 1, so there are no friend-of-friend walks.
  - *Later (post-v0):* server-side search over the permission graph. It is blocked on an open SociACL question about group search tokens.
- **Browse**: origin tree **Networks → users/orgs → sources**. Networks are grouped as *This network*, *Other s3r.ch networks* (added by URL; read through that deployment's seed peer) and *Protocols*. Lazily expanded. Each source gets a checkbox; a server gets a tri-state "select all visible". Selections stay across tabs and filters.
- **Filters**: by kind; **Live now** (presence heartbeat within TTL, or a stream marked live); **Unread** (local cursor).
- **Previews** go through Check exactly like reads. A locked source shows **no content**, only metadata the user can already see (name, owner, kind). Readable previews only show data that already exists: last 2–3 messages (room chat / forum read / pulled items), presence count (rooms only), live thumbnail (streams, later). Fields with no data are hidden, never shown as "0" or as placeholders.

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
- `Join`: public room or forum invite that is ready to accept.
- `Sign in required`: signed out, or the source needs a linked provider (e.g. Bluesky post).
- `Read-only`: pulled public sources (no outbound for AP/Nostr/RSS).
Revoke is immediate on the dest ACL: the window keeps its slot and shows "Access removed". It never silently disappears.

### 3.8 URL / invite paste
Resolver order: s3r.ch room/forum link → ATProto (`bsky.app/profile/…`, `at://`) → Farcaster (`warpcast`/channel) → Nostr (`npub`, `nevent`) → AP actor → RSS/Atom autodiscovery → stream URL (later). The result is one card (`Detected: Bluesky account @x · feed · read-only · [Add]`) or an error: "Not a supported source yet" (listing what is supported) or "Couldn't reach it". Uses the existing `url-guard` and ingest proxy.

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
- Seed peer/WebRTC down: the picker still lists Mine and recents from local Gun. Network and Granted rows are greyed: "Needs connection". Additions are queued locally and sync later.
- Ingest failure for a provider: that server node shows "Couldn't load · Retry"; other providers are unaffected.
- Window whose source is gone or unshared: "This source is no longer available" [Replace] [Remove].

---

### 3.12 Access requests (v0)

**A request is a hint, never permission.** Access exists only when the owner's (or an org admin's) client writes SociACL grant rows. No request, notification or inbox delivery implies access, and no client caches "allowed" past a cancel: when a cancel merges, the cached state is dropped and Check runs again.

**Request object** (Gun, `s3rch/requests/<owner>/<id>`):
```ts
type AccessRequest = {
  id: string; requester: string;            // wallet / org principal
  source: string;                           // canonical SourceRef
  scope: "read" | "read+post";
  body: string;                              // SEA ECDH-encrypted {message?: string ≤ 280}
                                            // requester ↔ owner; org sources: one copy per admin key
  status: "pending" | "approved" | "declined" | "withdrawn" | "revoked";
  statusSig: string;                        // signature over (id, status, ts) by an allowed signer
  ts: number; decidedBy?: string; decidedAt?: number; v: 1;
};
```
- **Who may write status:** `withdrawn` is signed by the requester. `approved` and `declined` are signed by the owner or an org admin. `revoked` is signed by the owner or an admin and is set when the grant is cancelled. Nobody else may write status, and readers verify `statusSig` against the allowed signer set and drop anything else.
- The canonical signed encoding and an approve→grant helper come from SociACL (SociACL #46).
- **Limits:** one pending request per requester per source. After a decline, a cooldown applies before that requester can ask again; its length is a setting per source/owner, not a fixed number.

**Policy per source** (s3r.ch policy, evaluated on the owner's or admin's client before any grant is written; SociACL itself has no standing deny):
- `public`: anyone may read and **no request is needed** to read. Requests exist only for `read+post`, which is auto- or manually approved per the owner's setting.
- `members`: members of listed groups/orgs auto-approve at a chosen scope. Membership is checked with the existing `checkGroupSee` on the owner's client.
- `manual`: everything goes to the queue.
Order: explicit deny (s3r.ch policy), then member/public auto rules, then the manual queue. A cancel always wins immediately.

**Auto-approve runs only on the owner's own system, or an org admin's for org sources, while that client is online.** No service issues grants on the owner's behalf. Requests wait in `pending` ("Waiting for owner to come online") until such a client connects and evaluates the queue.

**Owner approval queue:** an "Access requests" panel with a count badge, reachable from source settings and notifications. Each row shows requester identity (ENS / held claims), source, scope and the decrypted message, with **Approve** (scope editable, optional expiry `until`), **Decline**, and **Always approve this group**.

**SociACL mapping:**
- On approve, the owner's client writes the see grant (`IdentitySeeGrant{claimId=source object, accessor=requester, from, until}`) and delivers onto `s3rch/granted/<requester>`.
- For `read+post` it also writes a **post grant**: a new owner-signed row with the same shape and cancel rule as the see grant (SociACL #45). Check returns `canPost` only if `canSee` also passes. The UI shows read+post only when both grants are live.
- Check never reads the request. Cancelling either grant is immediate on the destination ACL, and the request becomes `revoked`.
- Forum channels map approve → existing `invite` / `group-add` actions.

**Cross-network (post-v0, undecided):** a link to another network is a URL plus untrusted hints. The destination network re-checks access and issues its own grant, and cancels stay on the destination's ACL. A grant from one network is never accepted by another. This needs a key binding across networks plus presenter-binding and freshness proofs.

## 4. Composer (in a View)
The composer belongs to a window. Merged feed windows and read-only sources have no composer. In a tabbed window it has a **required target selector** showing the chip of the source it posts to (defaults to the last source the user replied to; replying to a message targets that message's source). Read-only sources can't be selected. One send = one source. There is no "post to all".

## 5. Persistence and sharing
- View config at `~/views/<id>` in the user's SEA graph (`user.get('s3rch-views')`), with `SEA.encrypt` using the user's own pair. Not on `s3rch/*` public paths. Recents/favorites live alongside it, also encrypted.
- **Share as template**: an exported JSON of windows + layout + `SourceRef`s only (no messages, no grants). The recipient's picker opens it with every row access-checked; anything they can't read shows `Request`.

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
- Author display is per source: wallet/ENS for s3r.ch, handle for ATProto/Farcaster, npub for Nostr, plus a provider mark. Mute/hide is local to the View; owner moderation stays in the source.
- Limits (starting values): 12 windows per View, 8 sources per merged window, 4 live video tiles, 1 voice room active.

## 8. Backend dependencies (revised)

| Need | Status |
| --- | --- |
| Rooms, chat, presence, forum read/post, Check, grant inbox | Exists |
| Pull adapters (ATProto, Farcaster, Nostr, AP, RSS) | Exists (read-only feeds, not chat-shaped) |
| `SourceRef {network, owner, source}` + adapters + unified row shape | Missing, client-side lib |
| Origin tree: other s3r.ch networks (multi-seed-peer Gun client), org principals | Missing (orgs exist only as forum groups) |
| Picker search v0: local index + mesh tag/public discovery, type-scoped | Missing; Discover gives partial tag browse |
| Access request object, per-source policy (public/members/manual), owner queue | Missing |
| Client-side auto-approve on owner/org-admin system (evaluate pending queue on connect) | Missing, client-side |
| Other networks: add by URL + permitted key | Missing (v0 assumption); directory later; cross-network requests/grants planned post-v0 (security-heavy) |
| Real search function (post-v0) | Missing |
| Server-side permission-graph search (post-v0) | SociACL [#47](https://github.com/FyberLabs/SociACL/issues/47), blocked on SociACL #31 (group search tokens); v0 filters through Check in the client |
| SociACL [#45](https://github.com/FyberLabs/SociACL/issues/45): owner-signed post grant (see-grant shape, same cancel rule); `canPost` requires `canSee` | Missing (SociACL repo) |
| SociACL [#46](https://github.com/FyberLabs/SociACL/issues/46): canonical signed request encoding + approve→grant helper | Missing (SociACL repo) |
| SEA ECDH request body encryption (owner / org admin keys) + status signature verification | Missing, client-side |
| Decline cooldown setting + one-pending-per-source limit | Missing |
| URL resolver | Partly (url-guard, ingest autodiscovery); missing as one module |
| Encrypted user-graph storage for Views | SEA helper exists; Views schema missing |
| Streams / voice / meetings (WebRTC + Panopticon TURN; relay/SFU for >few viewers) | Missing (ROADMAP item 3). TURN allocate exists |
| Discord / Matrix / Twitch / YouTube adapters | Missing; Discord fits under the bot-plane adapter work |
| Live state for streams ("live now", thumbnails) | Missing |

## 9. SociACL dependencies

| SociACL issue | Unblocks s3r.ch PRs | Phase |
| --- | --- | --- |
| [#45](https://github.com/FyberLabs/SociACL/issues/45) Owner-signed post grant (read+post) | 4 (inline canPost state), 5 (targeted composer posting), 11, 12 | v0 |
| [#46](https://github.com/FyberLabs/SociACL/issues/46) Signed access requests + approve-to-grant helper | 11, 12 | v0 |
| [#47](https://github.com/FyberLabs/SociACL/issues/47) Permission-filtered search | 17 | post-v0, blocked on SociACL #31 |
| [#48](https://github.com/FyberLabs/SociACL/issues/48) Cross-network requests and grants (security design) | 19 | post-v0 |

Until #45 lands, v0 windows show read-only for s3r.ch sources the user does not own.

## 10. Suggested PR split
1. `SourceRef` + source adapters (room, forum, feed) + unified row type + Window schema enforcing `merged ⇒ kind feed`, with tests.
2. Views schema + encrypted Gun persistence + recents/favorites.
3. Picker v0: Recents / Favorites / Browse tree, multi-select, kind inference, quick add (desktop dialog).
4. Inline Check states + pending window state.
5. Split-window decorators (color, label, origin badge) + merged feed window (validation rejects merged non-feed windows, with a test) + targeted composer.
6. View route `/views/[id]` + split layout + unread + focus.
7. Swap/move/replace + undo stack + drag-and-drop with menu equivalents.
8. URL/invite resolver + paste entry + command palette.
9. Mobile full-screen picker sheet + long-press "Add to view" + mobile layout.
10. Template export/import.
11. Access requests: encrypted request object + signed status + limits/cooldown + requester form + owner queue + grant-on-approve (manual policy). Depends on SociACL #45 (post grant) and #46 (request encoding + helper).
12. Request policies: public / group / org auto-approve, evaluated on the owner's or an org admin's online client; pending queue on connect.
13. Origin tree: org owners + other s3r.ch networks added by URL + permitted key; `SourceRef` network field wired through.
14. Search v0: type-scoped joined + public/tag mesh search (client index + live discovery).
15. Later: stream/voice windows on top of ROADMAP item 3; external chat adapters; merged chat via @-reply addressing (future).
Post-v0:
16. Real search function.
17. Server-side permission-graph search (SociACL #47, blocked on SociACL #31).
18. Network directory.
19. Cross-network access (SociACL #48, security design first): destination re-checks and issues its own grants; cross-network key binding, presenter binding and freshness proofs.

## 11. Open items
None for v0. Cross-network requests and grants need their own security design before implementation.
