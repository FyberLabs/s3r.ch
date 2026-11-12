# Tenant record storage

`RecordStore` provides bounded named bytes for `cache`, `recovery` and `fixtures`.
Names contain 1–128 ASCII letters, digits, underscores or hyphens. Values contain
1–8 MiB of opaque bytes. This is separate from immutable media `ObjectStore`.

The server-only `createSpanopticonRecordStore` adapter binds a deployment-owned
HTTPS origin, tenant UUID and service key. Record keys have their own
`storage:records:read`, `storage:records:write` and `storage:records:delete`
permissions. No Azure credential or provider URL reaches the consumer.

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
