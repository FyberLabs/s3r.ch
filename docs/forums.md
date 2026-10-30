# Squad forum

One local demonstration on `/feed/squad`: a board of agent tiles, browser-local chat, and an agent drawer.

## Current isolation boundary

The fixture owner is a public cryptographic test-vector identity, not a secret
operator key. `PILOT_MESH_ENABLED` is hard-disabled: the squad component does not
create/register a Gun connection, subscribe to forum data, publish records or ACL
changes, or restore earlier mesh high-water snapshots. Local chat remains usable
and the page labels itself as a demonstration. Other app routes are unaffected.
The sample owner must never authorize live forum messages.

The contract and receive-path descriptions below document the retained,
unit-tested implementation, not an enabled deployment. Re-enabling live forums
requires a separately provisioned owner, a new forum namespace, removal of sample
authority from the live graph, and owner-signed, soul-bound ACL ingestion. Merely
flipping the isolation constant is not a supported deployment procedure.
Unauthenticated primary ACL ownership and grants fail closed for every object,
including non-fixture needs; there is no unsigned fallback.

Identity is the GunDB SEA pubkey. A wallet and a Panopticon OAuth subject are linked header credentials. They are not the forum principal.

## Souls

```
s3rch/forums/<forumId>/agents/<seaPubkey>                         → status
s3rch/forums/<forumId>/needs/<needId>                             → need
s3rch/forums/<forumId>/needs/<needId>/offers/<offerId>            → offer, owned by the helper
s3rch/forums/<forumId>/alarm                                      → pinned alarm
s3rch/forums/<forumId>/template                                   → distinct-principals | role-labels
s3rch/forums/<forumId>/roles/<roleToken>/<seaPubkey>              → membership
s3rch/forums/<forumId>/agents/<seaPubkey>/subtasks/<objectId>
s3rch/forums/<forumId>/agents/<seaPubkey>/updates/<objectId>
s3rch/items/<item key>                                            → chat item
```

The SEA pubkey is one Gun segment. It contains a dot. Do not split that segment on `.`.

Chat is a tagged item. The tag is `forum:<forumId>`. There is no separate chat soul. A hop, a hint, a status node, and a chat tag do not mint a grant. The destination runs Check again.

## Offers

Anyone Check see allows on the need may post a live offer (`stated` 1). That does not set the need to `stated` 0. The offer soul is `s3rch/forums/<forumId>/needs/<needId>/offers/<offerId>`. The offer id is kind `offer`, and the embedded principal is the helper SEA pubkey. The helper owns the row and may withdraw it (`stated` 0) until the need is resolved on that offer.

The need owner or the subject accepts one live offer only when the graph holds the offer that helper posted and that helper still passes Check see. A caller-supplied offer that was never posted is refused. When the subject is the helper, that principal may accept their own offer. Accept sets `stated` to `0` and `accepted_offer`. Decline sets that offer to `stated` 0 and leaves the need open. Reopen is the owner only. It sets `stated` to `1`, clears `accepted_offer`, and keeps earlier offers. Accept does not elect. The admitted owner of the need stays the owner.

This page puts those four rows with a Gun signature from the writer. It does not put an unsigned stand-in. `body` and `severity` stay as posted. `spec` is an optional object id and stays as posted. A resolved need refuses withdrawal of the offer it names.

Pause and reassignment are unavailable on the pilot. The earlier buttons only
wrote status labels and could claim success without revoking access or stopping
work. Their local/mesh write handlers and optimistic success notices have been
removed. The disabled controls explain that revocation and worker confirmation
are not yet available, including on the sample board.

SociACL #148 specifies the replacement workflow: durable complete destination
inventory, authority from every destination owner, signed post/see/group
cancellations, reconciliation after lost responses, and worker fencing/drain
before pause or replacement grants. None of those may be inferred from a status
put, a missing row, a stale Check, or an offline local edit. There is no enable
flag for these controls; implementing and testing the actual coordinator is
required before they become actionable. Group/drawer adoption and that
coordinator remain in s3r.ch #140 (with #146 as the duplicate context).

## Alarm

The alarm chip is on when a tile state is `emergency`, or when the alarm soul pins an open emergency need in the same forum. Either one is enough. The pin counts only when `pinned` is `1`, `alarm.need` is that need, severity is `emergency`, and `stated` is `1`. A pin and an unpin each carry an owner-signed `rev`. A signed copy at or below the last accepted `rev` does not replace the pin. The alarm record is data, not a grant.

## This page

The sample roster is local. Mesh rows at the souls above replace a matching tile only when a Gun signature on that row checks out. The sample is not written out by itself. An admitted sample owner stays the owner when a mesh ACL edge names another pubkey. A grant does not replace that owner. An unsigned mesh grant is not Check see on a sample need.

The signer of a status row is the agent pubkey, when that pubkey is already on the roster, or the forum owner. The Gun map key is the agent pubkey on the signed row. A self-signed status does not add a new pubkey. Owning the status id does not admit one either: an unsigned ACL edge can name that owner. The forum owner admits one by signing that status, or by signing a role membership at `roles/<roleToken>/<seaPubkey>`. An unsigned `null` does not remove a verified status or its alarm contribution. A removal is a signed record (`removed` is 1 and `action` is `remove`) by that agent or the forum owner, bound to that forum, that status id, and that map key.

A need row is signed by the admitted owner, or by the subject when that row accepts an offer and leaves the posted body, severity, and spec in place. A close installs only when that accepted offer is a live posted offer and the helper still passes Check see. A subject-signed close is kept when this browser already holds that need's admitted subject, or when the close carries the owner's signature of the open row and that signature names the same subject. A fresh close the owner signed is kept when those same gates pass. A payload `subject` alone is not an admission. This browser remembers the highest signed hamState and refuses an older replay after reload. An owner-signed need that arrives before ownership is loaded is kept only inside a cap, a per-forum cap, and a TTL, and it is checked again only when that need's owner appears. The alarm is signed by the admitted owner of the forum id, and a replayed unpin does not clear a newer pin. A live offer is signed by the helper and kept only when that helper passes Check see on the parent need. A live offer that arrives before that grant is loaded is kept and checked again when the grant appears. The need owner or subject may sign a cancel. A cancel (`stated` 0) is also put on `offers/<offerId>/cancel`. A later live copy at the offer key does not replace that signed cancel. A cancel that arrives before the need owner is loaded is kept and checked again when that owner appears. After a need accepts an offer, the helper cannot withdraw or remove that offer. That check uses the subscribed parent need. An unsigned need field that names another need is refused. The owner or the subject may still sign a removal. A chat line is signed by its author. The statement id names that author, so a different key cannot replace the line. A removal of that line is checked on its own. The author is read from the id, so the removal still hides the line when it arrives first. A later put of that same statement id has to be that same author. This browser drops its local copy when that verified mesh row arrives. A removal subscription is opened only after that row verifies, and only inside a cap and a TTL. A retained signed removal blocks older live copies within the bounded retention window described below. A signed need removal drops that id from the board, including the sample row. A signed agent removal drops that pubkey from the board, including the sample tile. The forum owner may hide the line and may not replace its body. An unsigned row is ignored, so a public peer cannot replace agent state, task, or result by writing a row under `agents`.

An unsigned `null` does not drop a verified need or offer. A removal is a signed record (`removed` is 1, `action` is `remove`) by the admitted owner or the subject, and for an offer also by the helper, bound to that forum, that object id, and that map key.

An unsigned `null`, a malformed put, or a tag strip does not hide a signed chat line. A retraction hides that line, including a copy kept on this browser, only when the author or the forum owner signed a tombstone (`unshared` is 1) bound to that forum and that Gun key. A signature read that finishes after a later put on the same key is ignored, so a retraction is not undone by a late read of the previous line. An id inside an unsigned tombstone does not hide a different line. A local descriptive status stays on the tile only while its `lastUpdate` is strictly newer than the mesh row. A later mesh `lastUpdate` retires it, so a newer emergency shows and counts for the alarm. These display rules do not confirm a task stopped. Reply in chat closes the drawer.

Forum writes are signed with the SEA pair unlocked on this browser. A wrapped key signs after unlock. The private half stays in page memory. It is not written back to disk or onto the mesh.

Role strips, Fleet, and Command are not on this page. `/forum` is still the desktop channel.

### Squad receive ordering and local replay state

The squad board keys offers, cancellations, and removals by the subscribed parent
need and offer ID together. A cancellation authorized on one need cannot hide or
replace another need's offer with the same ID. The single-need Check calls receive
only offers for that parent.

A fresh closed need can retain a bounded, owner-authenticated parent context while
its accepted offer loads. That context permits offer verification but does not
install the closure or clear an alarm. The live-offer and Check gates still run
before the closed need becomes visible. Subject-signed need removals try the
already admitted subject key without requiring an unsigned subject hint.

Signed statuses waiting for roster admission keep the newest `lastUpdate`, with a
128-entry cap and five-minute expiry that replays do not extend. Agent removal and admission child listeners open for admitted agents or verified
self-signed statuses awaiting admission. They are capped at 128 agent keys per
board (two child listeners each) and expire after 12 quiet hours. A timer releases expired listeners even without new mesh events.
The callback generation cache is also bounded; evicted verifications cannot become
current again when a key returns.

The board saves its highest admitted status per agent in browser-local storage.
After reload it restores that state and rejects older or conflicting equal-time
statuses. Exact repeats are idempotent. This is continuity for this browser, not
proof that a first-time visitor has the latest mesh state. Clearing storage, using
a different browser, or denied storage writes removes persistence across visits;
mesh signatures alone do not establish global freshness. No SEA private keys are
stored in this replay cache.

Pending need removals retain their `need-remove` generation and a separate queue
slot from live need rows. A later live event cannot erase or change the scope of
a removal awaiting ownership. Both slots expire within five minutes.

Need-removal and parent-offer listeners now require authenticated need context
(or the admitted pilot fixture). Together with role listeners, they share a
128-listener limit and a 64-per-kind limit. Role discovery needs a child read to
obtain the signed membership: at most 16 unverified role probes may remain open,
for 30 seconds each. Untrusted token events cannot renew that window. Only an
owner-verified membership promotes a probe to the 12-hour verified window. A timer
expires listeners and calls `.off()` even when the graph is quiet.

Forum revisions reject the maximum safe integer. A subject may close only the
immediate successor of the admitted open need, with space left for an owner
reopen; a subject cannot choose an arbitrary high HAM counter, including through
a carried owner admission. Received status timestamps are bounded to 299 seconds
in the future for agents and 300 for the owner. An owner-authenticated status update may advance past
the displayed revision as well as the current clock, preserving an immediate
override at the agent's accepted boundary. This only changes displayed status. These are squad admission limits;
shape-valid signatures alone do not authorize an extreme revision.

Admitted pilot agents subscribe to their signed removal children immediately,
using the same bounded listener registry as mesh-admitted agents. A sample tile
does not need a published live status before its signed removal can be heard.

A subject closure may carry a newer owner-signed open admission than this browser
remembers. Verification selects that newer matching admission, then checks the
immediate successor and live accepted offer. It still rejects a closure older
than cached state or one that changes the admitted subject.

Squad chat retains at most 256 recent deliveries in each mesh/local buffer and
renders at most 256 combined lines. Edits replace the existing ID and count as a
recent delivery. Eviction follows delivery order, so a forged future timestamp
cannot permanently occupy the window. Rows larger than 16,384 serialized string
characters are rejected. This is a bounded view of public chat, not full-history
pagination or deletion from Gun; earlier rows may remain on peers.

Chat removal listeners rotate with the 256-message delivery window and release
an evicted key's listener. Visible rows keep their listeners alive; quiet keys
outside the window expire. Authenticated chat tombstones and hidden IDs share a
512-entry, 12-hour cache. Duplicate deliveries do not extend expiry. Oldest
entries are evicted at capacity, so suppression is not permanent beyond eviction
or expiry; retained mesh removal records can reestablish it when delivered again.

Owner-signed agent status is also retained at `agents/<pub>/admission`. Later
self-signed status writes preserve this separate proof. A fresh reader verifies
the admission with the forum owner's key before installing the newest pending
self-signed status. Agent signatures cannot grant admission. Role membership
remains an alternative admission path. Previously overwritten owner signatures
cannot be recovered retroactively: the owner must republish admission when no
proof remains on the mesh. No private key is stored in the admission child.

Authenticated pending closures use an independent retry generation. Older open
rows, malformed deliveries, and conflicting equal revisions cannot discard that
context while its offer or grant loads. A newer accepted revision or valid
removal invalidates the pending retry; the existing five-minute expiry still
applies.


Offer withdrawal/removal authorization selects the freshest authenticated parent,
including an unexpired pending closure, and rechecks after signature verification.
The closure remains hidden until its offer and Check dependencies validate.

Combined chat retention uses local receipt order across both buffers. A newly
submitted local-only message can displace an older mesh row even when remote
payload timestamps are far in the future. Verified mesh copies retain precedence
for duplicate IDs.

Accepted offer buffers and the combined drawer view retain at most 32 offers per
need and 256 overall, evicting oldest deliveries. Incoming envelopes are rejected
above 16,384 serialized characters before signature verification, and retained
payloads have the same bound. This is a bounded history window, not pagination or
a guarantee that every older offer remains available for closure hydration.

### Drawer path transport

`forumArtifactSoul` now matches the SociACL #147 artifact path alongside
`forumSubtaskSoul` and `forumUpdateSoul`. The Squad writer uses the tested
`forumSoulNode` traversal: only `/` separates Gun `get` calls, so a SEA pubkey
including its literal `.` remains one segment. Empty segments and separate chat
trees are refused before traversing the graph.

These builders and transport do not authenticate ownership or authorize writes.
Mesh-backed drawer records still require admitted agent-owned object records and
the direct see plus post checks described by SociACL #147. Artifact references
do not confer access to their targets.

Check evaluation requires a nonnegative safe-integer timestamp (negative zero is
also refused), matching the consume contract. Invalid clocks deny before owner
or grant lookup, including offer preparation and helper checks at acceptance.

Offer authorship does not admit an ACL object owner. Preparing or publishing an
offer never calls `putObject` or persists ownership for the offer ID. The helper
remains the signer of the offer row, while acceptance rechecks access to the
parent need. Any independently authenticated object admission stays unchanged.
