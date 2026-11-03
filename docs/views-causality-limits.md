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

## Publication isolation and upgrade behavior

New manifests sign `recordScope: "publication"`. Records are stored at
`~<pub>/s3rch-views-records-v2/<writerId>/<manifestHash>/<address>`, where
`manifestHash` is SHA-256 of the canonical signed manifest body without its
signature. Re-signing identical content keeps the same namespace. Different
sequences or contents have separate namespaces even when cached ciphertext and
its content address are identical.

Before writing records, the publisher stores its signed manifest as a staging
intent at `~<pub>/s3rch-views-staging/<writerId>/<manifestHash>`. A completed
publication removes its intent. A later sequence from that writer cleans up
older staged publications in their own namespaces; a failed cleanup leaves its
signed intent for retry. Pruning uses the manifest hash and signed record scope
in the removal tombstone, including after the manifest has already been deleted.
It never sweeps another publication's namespace.

Tests pause a publisher during record writes and during the manifest write,
then complete pruning using an independent lock. Both the staged records and
reused ciphertext survive, and the published backup restores without missing
records. The original independent-lock regression fails before isolation.

Legacy manifests without `recordScope` still restore from
`~<pub>/s3rch-views-records/<writerId>/<address>`. Their superseded manifest and
index can be removed, but their shared records are retained: an older client may
still be writing there. New graph publication rejects legacy manifests; restore
them and build a new backup before publishing. No encrypted file contents need
to be rewritten just to read an old backup.

Upgrade all backup-writing clients before relying on new publications. Older
clients do not include `recordScope` in signature verification and cannot read
new manifests. Record paths, the signed manifest and tombstone format, and staging
intents changed; no environment variables or deployment flags were added.

## Remaining acceptance for #121

The reproduced cross-device record sweep is fixed for new publications. This is
not yet full storage-bound acceptance: safe reclamation of legacy shared records,
physical Gun deletion metadata, and retirement-map growth remain. The repeated
restore test covers 32 fresh writers with bounded live rows, no pending staging
intents, and one live vector component; it deliberately asserts that the shared
retirement map still contains 32 device counters. Issue #121 stays open until
those remaining storage and migration requirements have a safe solution.
