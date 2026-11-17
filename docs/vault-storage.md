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

The authenticated `/api/vault` POST adapter accepts bounded ciphertext operations
only for deployment-bound owner/vault pairs. It re-resolves the current session
principal and verifies a separate owner-key signature over the operation domain,
origin, vault, action, object address, ciphertext digest, expected revision and a
maximum 60-second validity window before storage access and before responding.
An identical signed write may retry within that window; the underlying CAS or
immutable object operation bounds replay. A stolen session alone cannot write.
A mutation whose response is denied or lost remains ambiguous: clients must use
the existing exact-head readback reconciliation before advancing their floor.

`createVaultApiTransport` supplies the authenticated browser transport to
`createVaultStorageClient`, with a local signing callback and same-origin cookies.
This does not supply custody keys, container-v2 encryption, end-user enrollment,
or UI. Provisioning remains disabled unless the explicit server configuration is
present. The service does not decrypt or verify private head contents; the client
still verifies those against its independently retained floor.
