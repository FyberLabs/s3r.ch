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
For those records, unlock the existing identity and select its complete canonical
keyring export. The app verifies it against the signed-in owner's current Auth/ACL
history. It never creates replacement history or translates a wallet address into
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
