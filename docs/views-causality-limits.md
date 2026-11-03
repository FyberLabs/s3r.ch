# Views causal-history limits

Visible conflict copies and tombstones have separate limits from the history
needed to compare old backups. Removing visible copies must not remove their
ancestry.

The store retains at most 128 incomparable hidden conflict stamps per View and
10,000 deletion summaries per account. Crossing either history limit now rejects
the operation. It never keeps only the first part of that history. The checks
apply when reading stored state, before an IndexedDB update, before building or
publishing a backup, and after combining restored copies. A record from an older
backup that exceeds the limit aborts restore rather than being skipped as an
unreadable record. The original stored state or backup remains intact.

At the limit, resolving retained conflicts still joins every hidden branch into
the new version. The deletion summaries continue to suppress older deleted
copies. An oversized existing backup requires a lossless migration; deleting
history or clearing browser storage is not a recovery procedure.

## Verification and remaining work

The Views store and backup tests cover both limits, a rejected update preserving
the previously stored state, encrypted restore unions in both manifest orders,
and restoring an older oversized encrypted record. Existing tests cover signed
writer retirement, failed cleanup retries, exact folded counters, and hidden
branches that must not collectively hide a retained concurrent copy.

The repeated-restore test counts live graph keys and live vector components. It
does not establish bounded physical Gun storage: the in-memory graph removes
null-valued keys, while replicated deletion metadata may remain. The account
retirement map also retains a counter per retired device.

The concurrent publish/prune test uses a shared in-process writer lock. Replacing the publisher lock with an independent no-op lock reproduces deletion
of its staged records while its manifest write is paused. Cross-device cleanup must
protect the record namespace of an in-flight publication without depending on
that lock. Issue #121 remains open for that protocol and end-to-end storage-bound
acceptance. History-cap refusal prevents silent loss but does not complete those
requirements.
