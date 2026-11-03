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
No production storage adapter is wired yet. A Gun put acknowledgement and a
browser-local store do not satisfy this port's cross-device contract.

The outbox checks record shape and cancellation polarity, not signature validity
or authority. Its fencing token is correlation data, not an enforced lock.
Records loaded from storage must pass fresh signature, owner, history and
retired-key witness verification before transmission. Preserve each envelope,
including attestations and independent group cancellation history. A successful
prepare is never a cancellation receipt or permission to issue replacement grants.

Remaining coordinator work:

- Select and wire durable storage with conditional creation and recovery tests.
- Fence dispatch, grant writes and new children while taking complete inventory.
- Verify owner authority for every destination and each cancellation path.
- Publish/reconcile the saved envelopes against authenticated durable ACL state.
- Require worker acknowledgement and drain before confirming pause.
- Issue fresh replacement grants and handle partial failures without restoring old grants.
- Integrate the controls only after restart, concurrency and live worker acceptance.
