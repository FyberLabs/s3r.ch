# Opt-in local ciphertext cache (#570)

`createLocalCiphertextCache` in `lib/ipfs-local-cache.ts` is an unmounted IndexedDB
adapter for client-owned ciphertext blocks. It has no network access, pin API,
provider credentials, reprovide loop, native route or reader registration. A cached
block means only that this browser currently holds a verified local copy; it does
not mean a recording is replicated or remotely available.

Native integration must supply an opaque 64-hex account/session partition and a
`current()` predicate that checks explicit retention consent and current grant
access. Scope is a local partition, not an authentication credential. Call only
with already encrypted raw blocks and their authenticated manifest CIDs from the
existing media encryption flow. CID validation proves byte integrity, not encryption
or ownership. No keys, wraps or plaintext are accepted as separate fields; the
helper cannot detect a caller deliberately supplying plaintext as a raw block.

The opt-in policy is required and captured at construction. Disabled read/write
calls do not open IndexedDB. The caller chooses lower limits within hard bounds:
64 MiB of ciphertext payload, 64 entries and 24 hours retention, with each block at
most 1 MiB. The database is shared across partitions; writes account for every live
partition in one read/write transaction, so different instances/tabs cannot race
past the cap. The writing instance's limits apply to the total current cache.
Metadata and IndexedDB engine overhead are additional to the ciphertext-byte cap.
Storage quota or transaction failure is reported as unavailable, never as durable
replication. No browser persistent-storage permission is requested.

Four operations may be outstanding per instance, including hashing. Transaction
admission is bounded separately, and database opens and transactions have two-second
deadlines. Applications must avoid creating unlimited instances; this helper does
not enforce a cross-tab JavaScript heap or request concurrency budget.

Writes verify the raw CID before storage. Reads verify it again before returning
ciphertext and recheck current consent, cancellation and expiry after hashing.
Existing CID retries cannot extend its original expiry. Expired rows are unavailable
and removed during subsequent successful read/write transactions. A persistent
clock watermark refuses reads/writes after wall-clock rollback until time catches
up. Local timestamps are not trusted remote authority.

`close()` denies further reads/writes and aborts outstanding transactions.
`clear()` deletes the caller partition even after close, opt-out or clock rollback.
Other accounts' entries are preserved. Native integration must close old instances
and clear their partition on account/consent changes or retention-policy reduction;
then create a fresh instance. Closing alone does not erase persisted ciphertext.
A consent change after a transaction has committed can leave ciphertext until that
cleanup, but it cannot pass this instance's subsequent guarded read.

TTL is an access/cleanup policy, not a promise of physical deletion while a browser
is closed or suspended. Eviction/browser storage deletion may remove copies sooner.
No service worker, background GC, durable pin lease or deletion of uncontrolled
peer copies is claimed. Unshare and epoch behavior remain with grant owners.

Tests use real Web Crypto with an explicit fake-indexeddb storage substitute. They
cover opt-out, local partitioning, caller mutation, concurrent instances and quota,
expiry across reopen, retry expiry, cancellation, consent loss, rollback cleanup
and expiry during hashing. This is unit/contract evidence, not real-browser disk,
provider, network-path or multi-client acceptance. #570 remains open for those
integrations and Infra's scheduled coverage. Reader cases remain unregistered.


## CI-only browser contract

`scripts/test-ipfs-cache-browser.mjs` runs in PR CI after the existing Chromium
installation. It uses the actual browser IndexedDB and Web Crypto implementations
with an isolated temporary persistent profile and a loopback fixture bundle. Two
tabs race to retain an encrypted block under one byte/entry cap; only one may
succeed. The test reloads the page, closes the browser process and reopens its
profile, then checks persisted ciphertext, non-extending retry TTL, expiry quota
reclamation, consent refusal, cleanup after clock rollback and partition isolation.

Consent and time are explicitly synthetic fixture inputs, not native grant or
real elapsed-retention acceptance. All browser network requests outside the fixed
loopback HTML/script routes fail the test. This proves the cache has no provider
path; it does not establish a future direct IPFS transport's network behavior.
The test is CI-only, not a scheduled reader registration or shared-host scenario.
Physical disk limits, browser eviction, suspended-browser cleanup, provider loss
and real multi-client replication remain separate acceptance work under #570.

## Targeted local eviction

`cache.evict(cids, signal?)` atomically deletes 1–64 selected raw block CIDs in this cache instance's partition. It snapshots and validates the entire selection before opening storage. Duplicate and missing CIDs are harmless. Unlike whole-partition `clear()`, unrelated CIDs and copies in other partitions remain intact. Committed deletions free the existing aggregate byte/entry quota for subsequent writes.

Erasure works after consent withdrawal, opt-out or `close()`, and does not require a valid clock or current grant. It shares the four-outstanding-operation limit and two-second storage deadlines; an already aborted signal refuses the operation. A transaction abort rolls back the whole deletion. Deletion does not reset the clock watermark or any transfer budget.

The caller must stop active transfers and close/replace stale cache users when withdrawing authority. Eviction is not a tombstone: it cannot recall bytes already returned to a reader, prevent an independently authorized writer from later caching the same CID, or erase provider/peer copies. Shared blocks may become cache misses for other items in the same partition. This optional API remains unmounted; native item/grant lifecycle wiring and live acceptance remain outstanding, and readers remain unregistered.

Unit coverage verifies selected deletion, partition isolation, quota reuse, mutation snapshotting, idempotence, malformed/cancelled selection, and the shared pending-operation bound. Actual Chromium CI fills three entries across two partitions, evicts one after withdrawal/close/clock rollback, reloads, verifies retained data, and reuses freed quota with no provider traffic.
