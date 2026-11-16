# Durable forum storage

`S3RCH_FORUM_STORAGE=blob` moves the legacy human forum ledger and its current
private desktop snapshots into one private Azure Blob document. It is opt-in;
existing installations continue using their file until migration is complete.
The native delegated-agent forum keeps its existing owner and authorization.

Both web colors use the same account and container through their system-assigned
managed identities. Grant Blob Data Contributor only on that container. No
account keys, connection strings, public access, or browser Blob URLs are used.
Each mutation reads the current ETag and writes with If-Match. A competing write
returns HTTP 409 (`store-conflict`); reload before submitting again. Failed writes
are never acknowledged as successful. Reads refresh the document on every call.

The envelope is schema 1, with the existing version-1 ledger and private snapshot
bytes committed together. The entire document is limited to 1 MiB. A full store
refuses a mutation without truncating or replacing existing data. Unknown schemas,
missing documents, denied access and malformed content fail closed. Health reports
`dependencies.forum` with `storage=blob`, `concurrency=etag` and read availability;
health serves cached state from a bounded asynchronous probe, so a storage
outage cannot block the health request. This read-only check is not a claim that a write has succeeded.

## Migration before enabling slots

Keep provisioning and Blob mode disabled until the migration is scheduled. First
ship this compatible capability to the single live web process. Quiesce forum
writes, retain a backup of its forum file, and configure the private Blob account
and container. Run `node /app/migrate-forum.cjs /app/data/forum.json` with the
app's managed identity in the existing owner environment. The destination must
not exist: the command uses If-None-Match and cannot overwrite a prior migration.
It validates the source ledger before uploading. Existing in-memory desktop image
bytes cannot be exported from the file; the next desktop publication supplies them.

Set Blob mode on the live color and verify its readiness through the normal
release workflow before enabling the staging color. Both the baseline and the
candidate must support this same envelope. Do not switch back to file storage
after accepting Blob writes. In-window rollback keeps Blob mode on both colors.
No migration, provisioning or live validation is performed by the unit tests.
