# Shared Spanopticon vault transport

`createVaultStorageClient` composes the installed SociACL vault-sync contract with
an authenticated transport and trusted local head decryptor. It authenticates the
owner-signed head and keybag/index digests before upload, conditionally publishes
the exact encrypted head, verifies record/object readback, then commits the client
floor. Lost responses reconcile exact bytes; conflicts never reseal or overwrite.
Keep prepared ciphertext for retry. Missing/altered objects leave the floor intact.

`createSpanopticonVaultTransport` is server-only. Configuration fixes the origin,
tenant and service credential; both products must select the same shared space.
It uses `/api/v1/storage/records/vault/{opaque-id}` and immutable object storage.
Core requires dedicated `storage:vault:read/write` scopes; object operations retain
their own scopes. Vault deletion and direct-provider access are not exposed.

A service credential must never enter browser code. The browser-facing authorized
proxy, tenant provisioning, scope assignment and product UI remain separate work.
This transport is not an end-user grant. The client custody adapter authenticates
and decrypts locally; keys and plaintext signed metadata must never reach storage.
Unit tests use a custody double, not production encryption. The v2 container and
legacy import remain SociACL work.

The 8 MiB transport bound is for encrypted head/index/keybag data; it does not
change the 1 MiB item cap. Reads still require Check and fresh epoch status. The
retained floor detects observed rollback, not proof of latest remote state.

All checks run in CI. Shared TEST storage and real browsers stay in the natural
nightly batch. This change does not activate a vault or dispatch that batch.
