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

Authenticated object access uses create-only vault records addressed by a domain-separated
hash of the vault ID and content digest. Another vault cannot retrieve ciphertext
by presenting its digest. The trusted deployment binding chooses the vault; browser
requests cannot select a tenant-wide object store. Existing direct transport adapters
remain untrusted primitives and must not be exposed as authenticated public routes.

CI also composes the installed SociACL signed-head/floor store, browser API
transport, authenticated service and vault-scoped storage adapter in one contract.
It covers a lost committed response, exact retry, successor publication, replayed
old head refusal, revoked-session refusal and retained state after reopening.
Storage and custody are explicit in-process doubles; this is not TEST deployment,
real browser PRF, or real-storage nightly qualification.

### Local private-head custody

`createVaultHeadCustody` seals the signed head using the existing `jose` General
JWE implementation: a fresh A256GCM content key, wrapped with A256KW, and an
allowlisted protected header binding the opaque vault ID. Owner and history
metadata remain inside the ciphertext. The envelope is bounded to 64 KiB and
accepts exactly one recipient, no external AAD or unprotected headers, and no
algorithm negotiation. The installed SociACL verifier authenticates the signed
head and current identity history before seal and after open.

The caller supplies a dedicated non-exportable AES-KW-256 key with wrap/unwrap
usage. Login never provides this key. `createSealedVaultStorageClient` composes
that custody with verified publication and readback. Call `sealHead` once and
retain the returned bytes for ambiguous retries; calling it again creates a new
ciphertext. `lock` drops the adapter's key reference, rejects in-flight plaintext
return and causes publication guards to refuse. It cannot cancel a remote write
already committed or revoke another holder's key reference. Mutable plaintext
buffers are cleared; JavaScript strings and garbage collection offer no assured
memory erasure.

This is a private sync-head envelope, not the container-v2 file or keybag format.
Slot enrollment, PRF/recovery derivation, durable key custody, cross-device unlock,
item opening with Check/epoch verification and the vault UI remain open. The
combined CI contract now uses this real encryption adapter with a CI-generated
local key; storage remains an in-process fake and no real PRF is claimed.
