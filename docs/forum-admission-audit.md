# Squad admission and replay audit

The Squad receive paths admit signed content separately from ACL authority.
`components/SquadForum.tsx` uses the current authenticated history resolver for
status, role admission, needs, offers, chat, removals and alarm signatures.
`lib/forum-receive-proofs.ts` keeps private receipts for the resulting objects.
Parsing, copying a record, or restoring browser storage cannot create a receipt.

A receipt binds the unchanged parsed content to its successful signer keys and,
where needed, the owner admission it depends on. Current history, ownership and
connection availability are checked again before display. Source replacement
resets receipts; disconnect fences unfinished verification. A one-second render
check removes data when the authority snapshot expires even without another mesh
event. Reconnection can reuse retained signed evidence only with current keys.
Roster principals may resolve from authenticated account history before they own
objects or receive grants; this does not grant them see or post authority.

Publication resolves the active physical key to one unambiguous stable principal.
Offer, accept, decline, reopen and chat writes recheck the signing identity and
applicable authority after asynchronous signing. Live chat requires direct see
and post authority on its separately admitted object. Descriptive rows do not
create ACL objects or cancel a worker's execution authority.

## Case-to-test map

All paths below are called from the app. Tests exercise their proof, parsing,
admission, ordering and projection boundaries with controlled transports;
`forum-squad-handlers.test.ts` also executes the actual component chat/offer
receive functions with controlled state and transport; the
matrix does not claim a deployed multi-client run.

| Requirement and app path | Regression evidence |
| --- | --- |
| `acceptStatus`, `acceptRole`, `enrollPub`, roster projection: owner admission before self-status | `forum-receive.test.ts`: real SEA owner admission; private bounded roster enrollment. `forum-squad-review.test.ts`: separate owner-signed admission survives self-signed replacement on a fresh reader; pending admission retains newest status without renewing expiry. |
| Current key lookup without incidental ACL edges | `identity/forum-authority.test.ts`: roster principals resolve from authenticated history before owning objects or receiving grants; shared keys cannot infer a publication identity. |
| `acceptNeed`: owner/subject binding and an embedded owner admission | `forum-squad.test.ts`: refuses a fresh close whose subject is only the signer's claim; accepts a fresh subject close with the owner's open row. `forum-receive.test.ts`: subject receipt inherits owner keys and current ownership checks. |
| `acceptOffer`: subscribed parent, helper and cancellation binding | `forum-squad-review.test.ts`: a second parent cannot cancel, remove or displace the first parent's offer; withdrawal uses the freshest authenticated pending closure. `forum-squad.test.ts`: derives helper and queues removal until parent loads. `forum-squad-handlers.test.ts`: both main-row and tail cancellation wait for the rotated parent, then preserve the accepted-offer veto; an authenticated reopen permits withdrawal. |
| Grant arrival and bounded deferred verification | `identity/forum-authority.test.ts`: receive paths defer offers until signed grants arrive. `forum-receive.test.ts`: detached retry hints, original expiry, separate live/removal channels, accessor rejection and in-flight limit. Existing pending need/offer bounds remain in `forum-squad.test.ts`. |
| `acceptNeed`: accepted-offer closure | `forum-squad.test.ts`: closes only with a live accepted offer and helper see authority. `forum-squad-review.test.ts`: fresh closed parent hydrates an offer without admitting closure prematurely; pending closure survives an older live replay. The receive path filters posted offers through current receipts before checking closure. |
| Need/offer/status/chat removals and cancellation tails | `forum-squad.test.ts`: signed removal ahead of older live row; chat removal before live line; forum/key-bound tombstones; cancellation before need graph. `forum-squad-review.test.ts`: pending removal preserves its independent generation. `forum-squad-handlers.test.ts`: successful chat retry installs a removal listener and consumes an existing signed tail without another parent delivery. `identity/forum-authority.test.ts`: cancellation tail survives self-echo but rechecks authority and parent state. |
| Nulls, malformed puts, stripped tags, unsigned siblings | `forum-squad.test.ts`: signed chat tombstone requirements and stale mesh read; `forum-drawer.test.ts`: foreign agent/forum/key substitution and malformed/unsigned input cannot replace evidence. `forum-receive.test.ts`: clones and changed content have no valid receipt. Invalid input does not clear retained display state. |
| `acceptAlarm` and emergency projection | `forum-squad.test.ts`: rejects replayed unpin at or below accepted revision; `identity/forum-check.test.ts`: emergency fan-in vectors. `forum-receive.test.ts`: identical alarm replay can rehydrate only after fresh verification; older/conflicting revisions cannot replace a saved floor. Pin display additionally requires a currently admitted open emergency need. |
| Same-key async races, rotation and connection loss | `forum-receive.test.ts`: old callback generation cannot commit; late verification cannot cross rotation/reset; disconnect fences pending work; inherited keys retire dependent rows. `forum-drawer.test.ts`: disconnect/publication race and actual authenticated rotation history without changing stable owner/path. |
| Reloaded unsigned caches | `forum-squad-review.test.ts`: unsigned status cache never populates live roster; restored need floors never become admitted content; corrupt/foreign cache tests. `forum-receive.test.ts`: deserialized signed-looking rows have no receipt. Alarm storage restores only a veto floor, never a pin or emergency. |
| Child subscription/publication paths | `forum-drawer.test.ts` and `forum-drawer-render.test.ts`; the full case map is in [forum-drawer.md](forum-drawer.md). |
| Public fixture isolation | `forum-squad-review.test.ts`: public-vector fixture cannot connect, publish or restore former mesh authority. `PILOT_MESH_ENABLED` remains false. |

## Bounds and persistence

| State | Bound and lifetime |
| --- | --- |
| Receive verification | 32 concurrent reads; signatures and retained content at most 32 KiB. Saturation denies that attempt. |
| Transport retry hints | 256 routes, 32 KiB per detached envelope, 30 seconds from original arrival. Live, cancellation and removal routes are distinct. Hints are reverified, never displayed. |
| Roster admission/status | 128 receipt admissions and status-cache entries; pending status expires after five minutes; status watches expire after twelve hours. |
| Need/offer deferrals | Existing five-minute queues, 32-entry limits with additional parent limits and 8 KiB payload limit in `forum-squad.ts`. |
| Chat | 256 displayed deliveries; 512 tombstones with twelve-hour nonrenewable retention; 256 removal watches. |
| Need/offer removal and offer cancellation floors | 512 entries per session set. Duplicate deliveries do not renew eviction order. |
| Agent removals | 128 entries per session; duplicate deliveries do not renew eviction order. |
| Alarm | One normalized browser-stored revision floor, read only below 4 KiB. Equal revisions require the same normalized update plus fresh signature/authority verification. |
| Child records | See the independent caps, expiry and replay-floor rules in [forum-drawer.md](forum-drawer.md). |

These are bounded replay protections, not permanent deletion guarantees.
Session removal/cancellation sets do not survive reload. Retained signed mesh
tails must be delivered again after reload or eviction; until then an otherwise
valid replay may be visible. Chat tombstones likewise stop suppressing replays
after expiry or eviction. Status and need browser caches restore only veto
floors. Removing storage, changing browsers, denied storage writes or tampering
with an unsigned floor can lose suppression or deny valid content; none can
supply a display receipt. Alarm floors have the same storage limitation.

## Remaining acceptance boundaries

The test map closes the admission/replay audit in #189. It does not establish
live service acceptance. #190 retains real identity provisioning, fresh authority
source configuration, browser reconnect and multi-client mesh evidence. Its
acceptance run must include actual mounted Squad subscriptions and publications,
reordered live/tail delivery after reload, expired history, key rotation, and
pin/unpin fan-in. The automated evidence above covers the app's shared boundaries
and controlled child controller; it does not mount every Squad handler against
a live Gun peer.

#188 separately retains durable cancellation, coordinator/worker acknowledgement
and reassignment fencing. A status, removed tile or accepted offer is never
proof that a worker stopped. No environment configuration, fixture activation or
deployment is part of this audit.
