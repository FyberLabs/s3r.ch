# Assignment and access changes

Squads coordinate assignments and SociACL access. Reassignment requires verified
prior-assignee cancellations and fresh grants for the replacement assignee.
Assignment and status metadata alone do not grant or revoke access. Existing
object ownership and paths are preserved.

The Reassign control remains disabled until these operations are integrated.
Squads do not require a worker runtime, execution pause, stop or drain in s3r.ch.
Those are not acceptance gates for #188 or the #190 live pilot.

## Cancellation retry storage

`lib/delegation-outbox.ts` preserves immutable retry material. Before publishing
cancellations, persist the operation ID, forum, agent, inventory binding and exact
signed envelopes. Retry the same operation ID and bytes after a lost response.
A conflicting intent under that ID fails instead of replacing the original.
Read-back must match before preparation succeeds. Never truncate a batch to fit
storage limits.

The storage port requires durable, linearizable create-if-absent and reads.
A Gun put acknowledgement or browser-local store does not satisfy that contract.
Parsing checks record shape and cancellation polarity, not signature validity or
owner authority. Loaded records require fresh signature, owner, history and
retired-key witness verification before publication. Preserve attestations and
independent group cancellation history.

`lib/delegation-blob-outbox.ts` implements the port with the existing Azure SDK.
It receives an explicit trusted primary-endpoint container client and an
authenticated scope digest. It reads no environment variables and provisions no
resources. Use a private container without secondary-read failover. Configure
managed identity and storage ownership during integration; never accept a
browser-controlled namespace or expose storage credentials.

Each operation occupies `s3rch-delegation-outbox/v1/<scope>/<operation>.json`.
Conditional creation (`If-None-Match: *`) preserves the first write. Exact
already-exists responses permit read-back comparison; other errors propagate.
Reads are bounded to 1 MiB plus one sentinel byte and reject truncation or invalid
UTF-8. Missing containers are errors. No overwrite/delete or history-pruning API
is exposed.

## Destination inventory and recovery binding

`lib/delegation-inventory.ts` maintains a bounded destination registry with an
operation-owned freeze. The Blob adapter stores it separately at
`s3rch-delegation-inventory/v1/<scope>.json`. Registration and freeze use ETag
compare-and-swap against the same blob. A registration racing a freeze either
enters the snapshot or fails. Competing operations cannot replace the winner.
Retry the same operation ID after a lost response or process restart.

Initialize explicitly during provisioning. Missing/corrupt live state fails
closed instead of resetting to an empty inventory. Capacity errors preserve all
existing destinations. Every destination must be registered before child creation
or grant publication. Registration is a reservation, not authorization for a later
write: assignment/grant changes still require concurrency control. This initial
registry exposes no removal, automatic expiry, thaw or reset API; repeated
assignment operations still need an explicit authorized transition.

`lib/delegation-bound-outbox.ts` requires a freeze owned by the operation. Its
`fence` field is a digest of forum, agent, operation ID and ordered destinations.
Recovery verifies that binding again. Signed bytes are snapshotted before storage
I/O. Unexpected registry replacement fails while preserving saved material.
Both adapters must use the same authenticated namespace.

Reassignment preparation also persists the intended replacement SEA public key in
that immutable document. `prepareReassignment` rejects the previous assignee or
an invalid key; `loadReassignment` requires the expected recipient to match.
Competing recipients, cancellation-only retries and lost acknowledgements cannot
replace the first saved intent. Older cancellation-only documents remain readable
but cannot be upgraded in place into a reassignment. This is internal retry
metadata, not a signed ACL field, recipient authorization or a completed assignment.
Fresh replacement grants still require independent owner authorization.

The digest grants no authority and introduces no signed ACL format. It does not
prove the registry includes every live destination or that the cancellation batch
covers every independent access path.

## Replacement-grant retry storage

`lib/delegation-replacement-grants.ts` persists a separate immutable plan of exact
signed direct-see/post grants. Before publishing any replacement grant, prepare
its complete intended batch with the saved reassignment operation ID and recipient.
The plan binds the entire cancellation document (including recipient and exact
signed cancellation bytes) and frozen inventory. Only positive grants for that
recipient at registered destinations are accepted; duplicate souls fail closed.
Group membership and object ownership changes are not part of this grant plan.

Retries preserve signatures, attestations, permissions and expiry. If only part of
the batch was published, recover and retry the original batch; do not shorten it,
renew its windows or restore old grants. A conflicting plan or changed operation
fails without deleting either document. Legacy cancellation-only operations cannot
prepare replacement grants. Plans are bounded to 512 records (at most one see and
one post per registered destination) and 1 MiB; no truncation is permitted.

`createBlobReplacementGrantStore` reuses the bounded conditional Blob adapter in
`s3rch-delegation-replacement-grants/v1/<scope>/<operation>.json`, separate from
the cancellation slot but under the same authenticated scope. No additional
configuration or environment variables are introduced.

This storage layer checks structure and intent, not signatures, owner authority,
freshness, cancellation completion or whether the chosen permissions satisfy the
assignment. The coordinator must independently authorize fresh grants, reconcile
old access before publishing, and verify complete durable replacement ACL evidence
afterward. Saving or loading a plan neither publishes it nor completes assignment.

## Access reconciliation

`lib/delegation-reconcile.ts` combines the bound outbox with the signed forum
authority resolver. The source must provide complete durable ACL evidence and
authenticated recovery history for the evaluation time. Every saved cancellation
must appear with its signature and attestation; invalid proof diagnostics block
reconciliation. Every frozen destination requires authenticated ownership, and
post, direct-see and group-read access must all be absent.

Canceling post access does not cancel read access. An assignee who owns a
destination retains owner authority; this flow does not transfer ownership.
After verification, the helper rereads storage and rejects changes or an expired
evaluation second. `acl-reconciled` is an instantaneous internal observation,
not an assignment-completion receipt or permission to issue arbitrary new grants.

`reconcileReassignment(operationId, replacement)` additionally loads the immutable
replacement plan and checks both sides against the same authenticated snapshot:
old-assignee access is absent at every registered destination, each exact saved
replacement grant is present, and its requested direct-see/post permission is
currently effective. Saved grant windows must be active; other grants or group
access cannot substitute for missing exact evidence or a canceled direct grant.
The cancellation document, inventory and replacement plan are rechecked after
verification, and an expired evaluation second invalidates the result.

`reassignment-access-reconciled` reports the recipient and number of checked
grants. It checks the chosen plan, not whether that plan includes every permission
an assignment needs. It remains an instantaneous internal observation: it does
not publish grants, change assignment metadata, or persist a completion receipt.
The coordinator still needs serialized mutation and complete durable providers
before this can drive the UI. Cancellation-only `reconcile` keeps its existing
meaning and does not require a replacement plan.

## Remaining integration and validation

- Wire authenticated scope, managed-identity storage and a trusted complete
  authority provider, including infra/config ownership and live validation.
- Register every destination/child and serialize assignment/grant mutations.
- Publish and reconcile exact saved cancellations, then issue fresh replacement
  grants under destination-owner authority.
- Persist assignment results and recover partial failures without restoring old
  grants; support later authorized assignment operations.
- Connect the controls and verify multi-client reload, retry and concurrent edits.

`bash scripts/test-delegation-blob.sh` runs digest-pinned Azurite on a random
loopback port and removes it afterward. Independent SDK clients test conflicts,
namespace isolation, stale ETags, bound recovery and replacement-grant plans after
emulator/process restart. Signed reconciliation tests exercise surviving independent grants,
missing authority, forged evidence and stale evaluations. Emulator and unit
results do not replace live Azure or multi-client acceptance.

## Future router commands

A future optional router setting may forward `pause` and `stop` command verbs to
independently operated agents. s3r.ch would submit a request; delivery, recipient
acknowledgement and execution outcome must remain explicit. Such commands do not
change assignments or SociACL permissions. They are outside #188/#190 and do not
require introducing an execution runtime in s3r.ch.

References: [Azure concurrency semantics](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage)
and [Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-install-azurite).
