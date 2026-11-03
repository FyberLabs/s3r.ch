# Authenticated drawer records

The live Squad drawer reads child records through `createForumDrawer` in
`lib/forum-drawer.ts`. `components/ForumDrawerRecords.tsx` owns its subscriptions
and publication controls; `SquadForum` mounts it only for the mesh path. The local
sample presentation stays separate. An unavailable authority source or signing
identity leaves the drawer status-only.

## Identity and admission

The child-write decision is retyped from SociACL
`b7f9bc59e800fef8420c9ced8040c925ef7ceac7`,
`typescript/src/post.js:checkForumChildWrite`. The artifact path uses the
existing copied `forumArtifactSoul` builder. There is no SociACL runtime import.

A child must have a separately verified ownership record. Both its embedded
principal and admitted owner must be the drawer agent. The agent's complete SEA
public key, including its dot, remains one Gun path segment:

- `s3rch/forums/<forum>/agents/<agent>/subtasks/<subtaskId>`
- `s3rch/forums/<forum>/agents/<agent>/updates/<updateId-or-promptId>`
- `s3rch/forums/<forum>/agents/<agent>/artifacts/<artifactId>`

The owner can write an admitted child. A delegate needs both current direct see
and post on that child. Group read, status, chat, needs, sibling access and path
spelling do not authorize a write or create ownership. The publisher offers only
already-admitted destinations of the selected kind; first creation uses the same
checks as later puts. Provisioning those destinations belongs to the authority
source, not to a descriptive record.

## Signed application envelope

The closed payload schema is `s3rch-forum-child-v1`: `domain`, `kind`,
`forumId`, `agent`, `id`, `writer`, `rev`, `issuedAt`, `stated`, `body`,
`state`, `target`. These are application records, not new SociACL ACL records.

The four kinds are `subtask`, `update`, `prompt` and `artifact`. Each ID has the
matching kind prefix. Subtasks carry pending/running/done/failed state; other
kinds carry an empty state. Only artifacts carry a target object ID. The body is
bounded to 2,048 characters; revisions and issue times are nonnegative safe
integers. SEA signs the entire payload; the transport adds `sig`. Unsigned
siblings are ignored. The subscribed collection, agent and map key must match
the verified payload.

The signer is a stable principal. The authority graph resolves its current key
from authenticated recovery history. Both the issue-time key and current key
must match the verified signature; future-issued or retired-key live content
cannot display. A key shared by multiple known principals is not automatically
assigned a publication identity.

## Reads, changes and removals

Displaying a row requires current direct see for the viewer, current child-write
authority for its signer, and a current signing key. An artifact additionally
requires independent direct see on its target for both writer and viewer; no
target body is fetched and no target ID is treated as a grant. Last-prompt
attribution comes from the signed prompt's writer, not from sample role labels.

Signing is asynchronous. The publisher rechecks authority, target access,
signing key, current publication identity, revision and connection generation
immediately before every put.
No optimistic child detail is displayed: the signed record must return through
the receive path. A sent result means dispatch to Gun, not acknowledgement of
durable storage or completion across peers.

A removal has `stated: 0` and is signed and authorized like any other put. It is
published to the child's `remove` tail before the main row. Subscribers watch
both locations. Signed child ownership also opens the removal-tail watch even
when no main row has arrived. Higher revisions win, removal wins a same-revision tie, and
canonical payload ordering breaks other ties deterministically. Different valid
SEA signatures of the same payload count as fresh verification of that payload. A later authorized
higher-revision live row can deliberately restore the same child. Nulls and
malformed rows do not remove content. Delayed proof completion cannot override
a newer removal.

Disconnect hides all records and fences pending work. Reconnect requires fresh
verification of the winning signed row before displaying it again; retained
revision floors cannot repopulate the drawer. Authority changes immediately
trigger reevaluation; a one-second UI refresh also hides content when an
exact-time authority snapshot expires. Every controller read and put checks
the clock synchronously. Closing the drawer disposes its listeners and proofs.
No unsigned local-storage cache is read.

The view is explicitly partial: a Gun map is not a completeness certificate.
Each drawer retains at most 128 distinct verified IDs, including removals, with
at most 32 simultaneous proof reads and bounded pending hints expiring after
30 seconds. Main rows and removal tails occupy separate queue slots, so a burst
of main-row replays cannot replace a queued removal. At the verified-ID limit it refuses new IDs rather than evicting
removal floors, and the UI reports the limit. Floors last for the open
controller's lifetime; a new drawer or page reload relies on signed main/tail
delivery again. This is not an unbounded archival or complete child-inventory
protocol. Durable delegation inventories remain a separate requirement.

## Verification map

| Boundary | Executable coverage |
| --- | --- |
| Copied owner/delegate, group, cancellation, expiry and malformed-destination rules | `lib/identity/forum-child-write.test.ts`; 11 pinned upstream decision cases |
| All four child kinds, full SEA segments and actual map/get/put traversal | `all drawer kinds traverse complete SEA keys and display only verified children` |
| Real SEA payload signature | `actual SEA signature verifies through the subscribed transport path` |
| Foreign owner/agent/forum, map-key substitution, unsigned/malformed content | `foreign agent/forum/key substitution and malformed or unsigned data cannot replace evidence` |
| First put before admission; authority loss during signing | `first create waits for signed object admission and rechecks after signing` |
| Revoked writers and independent artifact target access | `see and post cancellation each hide received rows and deny publication`; `referenced artifacts require separate current writer and viewer reads` |
| Late proof, signed removal, replay and self-echo | `late verification, stale revisions and unsigned nulls cannot undo a removal`; `removal publication persists its tail first and tolerates self-echo` |
| Reconnect, viewer loss, exact-time expiry and old async work | `reconnect needs fresh verification while retaining replay floors`; `disconnect fences an in-flight signature and publication` |
| Re-signed identical content and identity changes | `reconnect accepts a new valid signature of the same winning payload`; `identity changes during signing fence publication` |
| Rotation with stable owner/path | `rotation hides old-key rows and accepts the new key without changing owner/path` |
| Bounded deferred verification and retained removal floors | `bounded pending hints expire without becoming display evidence`; `capacity refuses new IDs without evicting signed removal floors` |
| Saturated reconnect and tail-only removal discovery | `a saturated reconnect queues all bounded children and preserves the removal channel`; `an admitted child discovers a standalone removal even when its main put was lost` |
| Authority loss during receive; wrong collection/tail | `grant loss while proof verification is suspended cannot commit a row`; `live rows on the removal tail and cross-collection records are refused` |

The React view's initial status-only and disabled-publication state is covered by
`lib/forum-drawer-render.test.ts`. A local Chromium check also mounted the real
component against an in-memory transport and a controlled authority source:
all four signed child kinds, publication, removal, stale replay, authority loss
and reconnect passed. It used real browser SEA signatures and exposed the
browser bundle's global `window.SEA` API requirement, now handled by the shared
signature loader. The temporary harness route is not part of the application.

The named subscription/publication cases are in `lib/forum-drawer.test.ts`.
Controlled verifiers are used for interleaving tests; the SEA case uses the real
signature codec, and ACL evidence in those tests uses real P-256 signatures.
The copied decision cases test the child-write decision against upstream
admission outcomes; they do not claim to retest upstream admission itself.
Regenerate them with `scripts/fixtures/copy-forum-child-vectors.py`.

Public-fixture mesh remains disabled. These are application/controller tests,
not deployed multi-client evidence. Real identity/source provisioning and
end-to-end rollout remain [#190](https://github.com/FyberLabs/s3r.ch/issues/190);
durable assignment/access changes and complete destination inventories remain
[#188](https://github.com/FyberLabs/s3r.ch/issues/188).
