# Tenant record storage

`RecordStore` provides bounded named bytes for `cache`, `recovery` and `fixtures`.
Names contain 1–128 ASCII letters, digits, underscores or hyphens. Values contain
1 byte to 8 MiB of opaque data. This is separate from immutable media `ObjectStore`.

The server-only `createSpanopticonRecordStore` adapter binds a deployment-owned
HTTPS origin, tenant UUID and service key. Record keys have their own
`storage:records:read`, `storage:records:write` and `storage:records:delete`
permissions. Account credentials remain inside Spanopticon. For Azure cache
reads, Spanopticon returns a Blob-specific read-only HTTPS URL lasting at most
60 seconds. The server-side consumer downloads the bounded record directly,
using the supplied provider ETag, validates the SPANREC1 envelope and computes
its revision. Spanopticon API keys are never sent to Azure. Delegated URLs are
not included in public feeds or logs. An issued URL can remain usable until
expiry after the service key is revoked.

The additive `cache/{name}/access` endpoint returns the storage path and
authorization. Older services (404) and unsupported providers (501) use the
existing proxied read endpoint; other failures fail closed. Once a direct
read is authorized, a failed or stale provider response is never treated as
an absent record or retried through the proxy. Recovery and fixture reads,
and all conditional writes/deletes, retain their existing API.

Reads return bytes and an opaque revision, or null when absent. A write with
`expected: null` creates only if absent. Replacements and deletions require the
revision previously read. A stale revision raises `RecordConflict`; the adapter
never retries a write automatically. Other failures have a static error message.
Calls reject redirects, compressed responses, malformed revisions and oversized
or truncated data, and accept cancellation with a bounded request deadline.

The public-feed consumer must reload the latest record after a conflict and
fetch fresh source windows before trying again. Replaying an older successful
window could restore deleted posts. Successful empty windows remove their old
posts; failed source windows retain their previous contents.

This client does not switch the deployed feed cache or provision its key.
Those steps belong to #340. Recovery and fixture namespaces do not define an
end-user secret store, access grant or encryption-key wrapping policy; those
remain SociACL responsibilities. Additional providers can implement this same
conditional contract without changing consumers.

## Optional self-hosted provider

`createAzureRecordStore` implements the same interface against an existing private
Azure container. Names remain tenant-scoped. The adapter uses Azure ETags for
atomic conditions and exposes a SHA-256 encoding of each ETag as an opaque
revision. Identical payload writes still advance the revision, and a deleted then
recreated record cannot accept an older revision. Container anonymity, malformed
metadata, incomplete downloads and unexpected provider errors fail closed.

The feed's explicit `azure` backend uses the server's Azure identity and primary
account endpoint. It requires no Spanopticon service or API key. The default
remote implementation remains Spanopticon; hosted Fyber configuration does not
select this optional provider. Custom deployments can supply another RecordStore
implementation with the same conditional create/replace/delete and size contract.
Copy and verify current records before changing an already adopted provider; a
missing destination must not silently resurrect stale local data.

An IPFS provider is deferred. Immutable content addressing alone does not satisfy
named conditional replacement. It must also supply a tenant-bound name index
with atomic revision checks and durable deletion state; blind last-writer-wins
IPNS publication cannot substitute for that contract. S3 can be added behind the
same interface (and is already a Spanopticon provider), without changing callers.

Recovery/fixture callers can pass a selected RecordStore directly. The future
SociACL secret-store adapter may depend on this byte-storage boundary, but must
implement its own encrypted metadata, owner/grantee DEK wrapping, current Check
and epoch-proof verification, revocation rotation, device keys and recovery as
specified in SociACL #155. This interface grants no access and defines no competing
key-custody scheme; the current namespaces are not a deployed secret store.
