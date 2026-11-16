# Durable forum storage

`S3RCH_FORUM_STORAGE=blob` moves the legacy human forum ledger and its current
private desktop snapshots into one private Azure Blob document. It is opt-in;
existing installations continue using their file until migration is complete.
The native delegated-agent forum keeps its existing owner and authorization.

The Blob-backed legacy forum is limited to explicitly admitted SEA owners.
Set `S3RCH_FORUM_ADMITTED_OWNERS` to a JSON array of at most twelve canonical
principals. Each has a reserved 64 KiB budget; public session issuance, invitations
and group membership do not create an admission. Unknown principals are refused
before Azure I/O. The private document independently retains the reservations.

Both web colors use the same account and container through their system-assigned
managed identities. Grant Blob Data Contributor only on that container. No
account keys, connection strings, public access, or browser Blob URLs are used.
Each request awaits a bounded asynchronous Blob read, runs the existing forum
model against that snapshot, and awaits a conditional commit before returning
success. Storage delays do not block unrelated requests. Each mutation reads
the current ETag and writes with If-Match. Conflicts reread and reapply the
operation with jittered backoff, for at most four attempts. Exhausted conflicts
return HTTP 409 (`store-conflict`); reload before submitting again. Failed writes
are never acknowledged as successful. Reads refresh the document on every call.

The envelope is schema 1, with the existing version-1 ledger and private snapshot
bytes committed together. Each owner has a 64 KiB growth budget (including private snapshot bytes), at
most 16 bots, 128 messages, 32 invites, eight groups and 64 group members.
Entropy identifiers are bounded to 64 characters. A quota refusal returns 429.
The document reserves 64 KiB for archiving and access revocation, which remain
available when growth is refused. Migration refuses a source that exceeds these reservations or contains an
unadmitted owner; it never truncates the source. Twelve full owner budgets plus
the cleanup reserve fit below the shared ceiling.

The entire document is limited to 1 MiB. A full store
refuses a mutation without truncating or replacing existing data. Unknown schemas,
missing documents, denied access and malformed content fail closed. Health reports
`dependencies.forum` with `storage=blob`, `concurrency=etag` and read availability;
health serves cached state from a bounded asynchronous probe, so a storage
outage cannot block the health request. This read-only check is not a claim that a write has succeeded.

## Migration before enabling slots

Keep provisioning and Blob mode disabled until the migration is scheduled. First
ship this compatible capability to the single live web process. Quiesce forum
writes, retain a backup of its forum file, and configure the private Blob account
and container, leaving the live runtime on file storage. Supply the account,
container and admitted-owner JSON as environment values on the migration command
only; do not restart the file owner by changing App Service settings first.
Run `node /app/migrate-forum.cjs /app/data/forum.json` with the
app's managed identity in the existing owner environment. The destination must
not exist: the command uses If-None-Match and cannot overwrite a prior migration.
It validates the source ledger before uploading. Existing in-memory desktop image
bytes cannot be exported from the file; the next desktop publication supplies them.

Set Blob mode on the live color and verify its readiness through the normal
release workflow before enabling the staging color. Both the baseline and the
candidate must support this same envelope. Do not switch back to file storage
after accepting Blob writes. In-window rollback keeps Blob mode on both colors.
No migration, provisioning or live validation is performed by the unit tests.

To admit an additional owner later, extend the explicit JSON list (maximum twelve)
and run the packaged command with `--admit-owners` using the app identity. This
compare-and-swap operation extends reservations without changing existing data.
Then update the runtime admission list on both colors. Removing an owner from
the runtime list revokes their access but retains their data and reserved space;
reservations cannot be automatically recycled or reassigned.
