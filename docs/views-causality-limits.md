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

## Verification

The Views store and backup tests cover both limits, a rejected update preserving
the previously stored state, encrypted restore unions in both manifest orders,
and restoring an older oversized encrypted record. Existing tests cover signed
writer retirement, failed cleanup retries, exact folded counters, and hidden
branches that must not collectively hide a retained concurrent copy.

The repeated-restore test retains null-valued deletion keys in the graph model,
matching the fact that deleting a live value need not reclaim its metadata. It
counts only live publication rows and live vector components, and separately
asserts growth of retained deletion keys and device-retirement evidence.

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

## Storage guarantee and acceptance

The storage guarantee is **bounded live backup data with exact historical
evidence retained**. It is not a fixed total disk quota and introduces no age
cutoff for old devices or backups. Gun deletion metadata and retirement evidence
may grow; dropping either to satisfy a total byte cap would change recovery
semantics. Existing import and causal-history capacity limits still reject an
operation rather than silently forget evidence.

For upgraded writers using publication-scoped records, sequential restore and
republish cycles retain one live writer manifest/index and only that snapshot's
live encrypted records after successful cleanup. Multiple concurrent writers
retain their incomparable snapshots until a published survivor contains them.
Failed cleanup retains explicit signed retry state. Per-version live vectors
track active devices; the shared retirement map retains exact retired counters.
The guarantee does not bound the number of independently active concurrent writers.

| Requirement | Acceptance evidence |
| --- | --- |
| Superseded writer cleanup follows published retirement evidence | Tests verify signed retirement before removal, cleanup failure and retry, retained staging intents, and preservation of concurrent snapshots. |
| Exact vector compaction | Tests check unseen components remain zero, folded markers expand against their original map, and retirement unions are order-independent. |
| Cross-device pruning safety | Tests pause record and manifest writes under independent locks, retain reused ciphertext in separate namespaces, and restore the new publication without missing records. |
| History survives display caps | Encrypted file recovery preserves hidden conflict stamps and deletion summaries. Resolving after recovery dominates every hidden branch; replaying all stale branches in either order cannot restore them. |
| Bounded live data across restores | Thirty-two fresh-writer cycles with retained null-valued keys leave one live manifest/index, at most two live ciphertext records for the one-view fixture, no pending staging/removal records, and one live vector component. Historical counters and deleted keys are retained and asserted separately. |

Legacy shared records remain a retained migration footprint. Active legacy clients
must upgrade before their writes are covered by the publication-isolation
guarantee; online deletion of their shared payloads is deliberately excluded.
Physical Gun compaction or a recovery cutoff would be a separate policy and
protocol change, not part of this storage guarantee. These qualifications define
the acceptance boundary for #121 rather than leaving its live-data work open.
