# Delegation cancellation recovery

Pause and Reassign remain disabled. A status update does not revoke access or
prove a worker has stopped.

`lib/delegation-outbox.ts` provides immutable retry material for a future
coordinator. Before publishing cancellations, persist the operation ID, forum,
agent, fencing token and exact signed cancellation envelopes. Retry with the
same operation ID and bytes after a lost response. A conflicting intent under
that ID fails instead of replacing the original. Read-back must match before
preparation succeeds. Never truncate a batch to fit the storage limits.

The storage port requires durable, linearizable create-if-absent and reads.
Create must leave an existing document unchanged. Network errors may have an
unknown outcome: load/retry the same ID rather than generating new signatures.
The Blob adapter below is not wired to a live coordinator. A Gun put acknowledgement and a
browser-local store do not satisfy this port's cross-device contract.

The outbox checks record shape and cancellation polarity, not signature validity
or authority. Its fencing token is correlation data, not an enforced lock.
Records loaded from storage must pass fresh signature, owner, history and
retired-key witness verification before transmission. Preserve each envelope,
including attestations and independent group cancellation history. A successful
prepare is never a cancellation receipt or permission to issue replacement grants.

Remaining coordinator work:

- Wire authenticated coordinator scope and a managed-identity primary storage client; validate Azure access and restart recovery in the deployment.
- Fence dispatch, grant writes and new children while taking complete inventory.
- Verify owner authority for every destination and each cancellation path.
- Publish/reconcile the saved envelopes against authenticated durable ACL state.
- Require worker acknowledgement and drain before confirming pause.
- Issue fresh replacement grants and handle partial failures without restoring old grants.
- Integrate the controls only after restart, concurrency and live worker acceptance.

## Blob outbox adapter

`lib/delegation-blob-outbox.ts` implements the storage port using the existing
Azure SDK. It receives an explicit container client and an authenticated scope
digest. It reads no environment variables and provisions no resources. Use a
private container on the primary endpoint, without secondary-read failover.
Configure managed identity and storage ownership during coordinator integration;
do not pass a browser-controlled namespace or give clients storage credentials.

Each operation occupies `s3rch-delegation-outbox/v1/<scope>/<operation>.json`.
Conditional creation (`If-None-Match: *`) preserves the first write. Exact
already-exists responses permit the outbox's read-back comparison; other errors
propagate. Reads are bounded to 1 MiB plus one sentinel byte and reject truncated
or invalid UTF-8 data. Missing containers are errors, not empty histories.
There is no overwrite/delete API or automatic history pruning.

`bash scripts/test-delegation-blob.sh` runs a pinned Azurite container on a random
loopback port. Independent SDK clients exercise conflicts and namespace isolation;
a fresh process reads the same bytes after the emulator restarts. CI runs this
separately from unit tests. The container is removed afterward. This establishes
emulator behavior, not live Azure durability, permissions, or worker fencing.

References: [Azure concurrency semantics](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage)
and [Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-install-azurite).

## Destination inventory freeze

`lib/delegation-inventory.ts` maintains a bounded destination registry with an
operation-owned freeze. `lib/delegation-blob-inventory.ts` stores it separately
at `s3rch-delegation-inventory/v1/<scope>.json`. Registration and freezing use
ETag compare-and-swap against the same blob: a registration racing a freeze
must either be included in the frozen snapshot or fail. Competing cancellation
operations cannot replace the winning operation. A lost freeze response is
reconciled by retrying the same operation ID, including after process restart.

Initialization is an explicit provisioning step, never a recovery fallback.
Missing or corrupt live state fails closed. Capacity errors retain existing
inventory. No destination removal, automatic expiry, thaw, or reset is exposed.

This registry is not yet wired into child creation, grant publication or worker
dispatch. Every destination must be registered before any such action. A
successful registration reserves inventory only; it does not authorize an
external side effect after the freeze. Those paths still need enforced fencing,
authenticated complete inventory reconciliation and worker acknowledgement/drain.
A stored frozen operation is not evidence that a worker stopped or that an ACL
cancellation took effect. Pause and Reassign remain unavailable.

The Azurite job covers independent concurrent registrations, stale ETag refusal,
registration racing a freeze, competing operations and frozen-state recovery
across emulator/process restart. Real worker and live Azure acceptance remain.

## Inventory-bound outbox recovery

`lib/delegation-bound-outbox.ts` composes the registry and outbox for a trusted
forum/agent scope. Preparation requires the registry to be frozen by the same
operation ID. The outbox's fence field stores a domain-separated digest of the
forum, agent, operation ID and exact ordered frozen destinations. Recovery checks
that binding again; a different scope or inventory cannot reuse those records.
Caller-provided cancellation bytes are snapshotted before the first storage read.
Unexpected inventory replacement during storage I/O fails without deleting the
saved material. Retrying after a lost acknowledgement recovers the same bytes.

This digest introduces no new signed ACL format and grants no authority. It binds
records to the registered snapshot; it does not prove that the registry includes
every live destination or that the cancellation batch covers all independent
access paths. Both storage adapters must use the same authenticated namespace.
The coordinator must still reconcile complete inventory, verify owner/cancellation
proofs, enforce dispatch/grant fences and obtain worker drain evidence before
reporting completion. The helper exposes neither publication nor resume controls.
