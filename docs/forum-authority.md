# Squad authority integration

`ForumAuthorityProvider` connects Squad's live read/write gates to the signed
P-256 authority graph in `lib/identity/forum-authority.ts`. The demo remains
browser-local. No production source is configured and the public-fixture mesh
remains disabled. Source provisioning, completeness guarantees and deployment
acceptance are tracked in #190.

## Source and time boundary

A provisioned `ForumAuthoritySource` supplies independently trusted witness/SIWE/
OIDC configuration and complete snapshots. Each snapshot contains raw recovery
history and all relevant signed ownership, direct see/post, membership, object-set
and cancellation records through `completeThrough`. It must include cancellation
predecessors, even when delivery was reordered. A missing predecessor or a cycle
invalidates the snapshot. Do not infer completeness from a peer's flag or an empty
Gun response. The source must signal invalidation when completeness is lost.

Admission is bound to one exact Unix second. Refresh clears old authority before
any asynchronous work; a superseded refresh cannot install its results. Every
lookup checks the clock and evaluation instant. An expired snapshot denies even
if React has not rendered again. Production source implementations must deliver
fresh complete snapshots, rather than reuse an allow from an earlier instant.

Rows have an envelope `{ kind, soul, record }`. For grants and group records,
`soul` must be the actual subscribed canonical ACL address; membership assents
and cancellation entries name the parent row address. For object admission it is
the canonical target object ID extracted by the transport adapter. This does not
introduce a new Gun collection. Never copy the envelope address from an untrusted
record's claimed address. Signatures bind all authority-bearing fields.

The graph accepts at most 1,024 rows and 32 distinct signers per refresh. The
underlying recovery resolver has its own documented bounds. Drawer signing-key
lookup additionally resolves direct-grant accessor histories, with a total cap
of 128 principals. A missing accessor history refuses that accessor's key lookup
without creating a genesis fallback or invalidating unrelated signer evidence. Missing or conflicting
history for any evidence signer invalidates the snapshot. Malformed or forged
rows are reported and cannot contribute authority. Refresh diagnostics distinguish
bad record/address, bad proof and retired-key rejection.

## Admission and Check

Ownership requires a signed object record whose minted ID embeds its owner.
Ownership is revalidated against authenticated current history for every refresh.
Live grants must be signed by the key valid at issuance and still current now.
Retired-key cancellation remains effective only with a matching timestamp witness
under the historical issuance key. A witnessed retired-key live grant is rejected.

Direct grants merge deterministically by signed HAM state, then cancellation,
then canonical signing bytes. See and post are separate. Group membership requires
both member and set-owner assents, the exact destination's owner-signed object-set
binding, and acknowledgement of every applicable signed cancellation. High HAM
alone cannot erase an unobserved group cancellation. Cancellation arriving before
the join is retained when the full snapshot is evaluated.

`checkForumSee` selects the admitted owner, a live direct grant, or that object's
live same-group/named-circle path. It does not accept a caller-selected set or
walk transitive memberships. Direct and group grants require independent
cancellation. The graph's direct `checkSee` and `checkPost` never treat group
membership as direct child-write authority.

Squad offer preparation, receive-path admission and helper acceptance all use
`checkForumSee`. Acceptance rechecks the helper rather than trusting the earlier
offer. Publication checks current authority again after signing, immediately
before dispatch; revocation or a parent change during signing blocks the put.
Live acceptance does not optimistically close the need before that gate.

Chat publication no longer calls `admitFeedNode` to create ownership. A separately
signed object admission and current post authority are prerequisites. Provisioning
the live chat writer and canonical object lifecycle remains part of #190.

## Legacy migration and isolation

The Squad route no longer mounts `SeeAclProvider` or `MeshAclSync`. It does not
hydrate unsigned IndexedDB ownership/grants. The new graph has no `putObject`,
`stateSeeGrant` or legacy snapshot import method. Legacy records remain untouched
for other routes; they acquire no authority by copying their owner strings into
the new source. Migration requires fetching signed source evidence and running
normal admission. The separate `/forum` route is unchanged.

Sample ACL ownership is used only on the hard-disabled browser-local branch. It
is never overlaid onto the live graph. Status, chat and needs do not mint grants.

## Contract and tests

Wire fields and signing bytes are copied/retyped from FyberLabs/SociACL commit
`b7f9bc59e800fef8420c9ced8040c925ef7ceac7`,
`typescript/ids/src/records.js` and `typescript/src/group.js`, with the forum
`checkForumSee` behavior described in its consume contract. This is the P-256
wire implementation, not an import of the Ed25519 reference graph/runtime.

The seven `forum-*` cases from `vectors/mesh/v2/group.json` are copied verbatim.
Tests evaluate them using one admission/Check instant, rather than the upstream
harness's independent Check clock. Reproduce the fixture with:

```sh
python3 scripts/fixtures/copy-forum-authority-vectors.py /path/to/SociACL
```

Additional tests cover unsigned cache exclusion, ownership collisions, path
substitution, first admission and arrival order, independent cancellation,
retired-key witnesses, expired snapshots, input mutation, superseded refreshes,
invalid times, offer/acceptance authority loss and revocation during signing.
Local and CI tests establish the consumer's admission behavior; they do not
establish live source completeness or deployed pilot acceptance.
