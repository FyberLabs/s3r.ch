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

The digest grants no authority and introduces no signed ACL format. It does not
prove the registry includes every live destination or that the cancellation batch
covers every independent access path.

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
namespace isolation, stale ETags and bound recovery after emulator/process
restart. Signed reconciliation tests exercise surviving independent grants,
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
