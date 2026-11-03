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
