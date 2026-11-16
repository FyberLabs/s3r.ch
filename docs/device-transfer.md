# Existing identity device transfer

Parent: hyperme-sh/spanopticon#85. Consumer: FyberLabs/s3r.ch#519.

`/identity/devices` consumes the packed SDK, Auth relay, ACL authority and shared
UI. `vendor/pairing/sources.json` records exact source revisions and artifact
SHA-256 digests. Packages are built by the preparation CI workflow; no local
builds, manual tags or publications are needed. The shared UI source archive
contains only that private repository's reusable package, not plane configuration.

The source must have complete canonical SociACL material. Previously received
identities unlock with their local PRF passkey. Older wallet-keyed records contain
only a SEA pair and cannot reconstruct retired encryption keys or content epochs.
For those records, unlock the existing identity and select its complete SociACL `KeyringMaterial` JSON
export. The app verifies all four current key fields match the unlocked pair, then admits
the full fields through SociACL against the transfer owner's current Auth/ACL
history. No contact-vault service is required. It never creates replacement history or translates a wallet address into
a principal. An incomplete legacy record is refused, not silently upgraded.

The destination creates its own PRF passkey and atomically writes the encrypted
full keyring, exact binding, owner checkpoint and completion to the existing
`s3rch-identity` / `mesh-keys` IndexedDB store. The principal-keyed record does not
assert a wallet link. Conflicting local identities are refused. The PRF envelope
also protects the receiver capability used for acknowledgement reconciliation;
no plaintext key, cookie or bearer is persisted in browser storage. This local
passkey has no new recovery guarantee; preserve the source and existing recovery
material. Unsupported PRF fails before the invitation is created.

After import, retry saved acknowledgement (including after reload) independently
of signing in. Sign-in calls the existing SEA challenge/exchange issuer and only
publishes the unlocked pair after success. Issuer refusal leaves the imported
record intact. No memberships or source sessions are copied. Full historical
keyring bytes remain preserved for SociACL readers; current-key-only application
consumers do not gain historical-reader support just by copying a pair.

Plane integrations must provision the existing OIDC client callback, person
scopes, exact origin/application/tenant/audience allowlists, relay and ACL routes,
and protected current owner history. These are configuration responsibilities,
not application UI actions. TEST continues tracking the moving service channel.

Browser acceptance belongs to the Infra registered nightly batch. Fixtures need
an existing complete source keyring, eligible person on each browser, configured
services and a PRF-capable destination. Infra owns fixture setup/readiness/teardown.
No substituted tenant, injected bearer, preauthenticated browser or manual shared
TEST run establishes acceptance. PR unit/contract CI and review govern merge.

The checked-in `scripts/test-device-transfer.mjs` is scheduled-only and remains
unregistered until Infra #1559 provides `DEVICE_TRANSFER_FIXTURE_DRIVER`. That
owner module must export setup/readiness/teardown. Its setup result supplies two
independent clean browser pages (`source`, `receiver`), canonical `origin`, and
real UI drivers `authenticate`, `unlockSource`, `completePrf`, `scanQr`, and
`assertIdentityAndAccess`. The last asserts same stable principal/current keys,
historical decryption, unchanged authorized scope and denied outside scope before
and after transfer. `scanQr` must exercise camera capture of the displayed QR;
mocking the scanner does not qualify that case. PRF setup must be real supported
protection, with explicit failure for unsupported clients. Setup owns any source
local fixture material and teardown removes temporary downloads/credentials.
The scenario covers QR cancellation, camera-free transfer, lost acknowledgement,
reload, reconciliation and existing-issuer sign-in. Missing driver is blocked.

## Restore an existing complete keyring (#583)

After authenticating the existing person through **Authorize device transfer**, a
fresh browser can select **Restore existing keyring**, choose **Existing complete
keyring export**, and press **Protect and restore existing identity**. This path
does not need an already unlocked SEA pair. It accepts a complete SociACL JSON
keyring, validates current owner history, and saves an encrypted copy under a
PRF-capable passkey. It refuses incomplete historical keys and any conflicting
local identity. It creates no identity, link, transfer acknowledgement or membership.

The **Restored identity** card exposes **Unlock restored identity and sign in**.
This separately unlocks and validates the saved copy against fresh owner state
before using the existing SEA issuer. Issuer refusal preserves the saved copy.
An exact retry reports an existing copy without claiming that it has been unlocked
or replacing its protection. **Cancel current identity operation** disposes the
current client and fences pending storage work. Account changes and expiry also
invalidate the client. An already committed copy remains available for readback.

These selectors support Infra's existing-person fixture driver. PR component and
native contracts are isolated CI checks; hosted browser/passkey acceptance still
requires the declared fixture and scheduled run. First enrollment remains owned
separately. Encrypted remote recovery retrieval, passphrase migration and the
linked-OIDC browser broker are still outstanding under #583; this slice does not
close that issue or register reader cases.

### Open an encrypted recovery copy

The authorized device page offers **Open encrypted recovery copy**. Its local JSON
transport has exact fields `version:1`, `principal`, `signingPub`, `epub`,
`rotationSeq`, and `ciphertext` (canonical unpadded base64url of the existing SociACL
recovery envelope). This wraps the shared library's ciphertext without changing
its cryptographic format. Use the original passphrase; legacy weak passphrases
remain valid for opening and are not approved for creating a new recovery copy.

Current authenticated owner history must confirm the identity before local passkey
protection is requested. Exact retries reuse the existing protected copy. Another
identity is never overwritten. Passphrase and plaintext remain in the browser;
mutable buffers are cleared, and account changes/cancellation refuse delivery.
JavaScript strings cannot be guaranteed erased. Unlock/sign-in is still explicit.
This slice does not fetch remote recovery copies or rotate keys/passphrases.

## Local encrypted recovery downloads

Create encrypted recovery copy unlocks a complete saved identity, or uses the
complete source selected in Send from this device. Enter and confirm a strong
new passphrase, including the public account handle in the strength context when
you use one. The downloaded JSON contains only authenticated metadata and the
canonical SociACL ciphertext. Verify the file using Open encrypted recovery copy
before relying on it. This does not publish a signed recovery-store operation,
rotate keys, or invalidate older copies. Session disposal revokes the download URL.
