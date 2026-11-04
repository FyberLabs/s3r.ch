# Squad live rollout (#190)

PR #218 completed assignment/access integration and isolated synthetic acceptance
for #188. Production rollout remains separate. The public `/feed/squad` route
continues to render the demo; it does not obtain live authority by changing a
fixture constant or URL parameter.

## Namespace isolation

`SquadForum` accepts an optional `LiveSquadSpec` (`forumId`, stable SEA `owner`,
`label`) from its provisioned application wrapper. Omitting it selects the demo.
Malformed live configuration throws instead of falling back to demo identities.
The forum ID must embed its declared owner, and neither the public demo namespace
nor any known fixture principal can be used as a live owner.

Live mode starts with empty roster, chat, needs and alarm state. It never creates
the sample ACL, admits the sample roster, uses sample labels, or restores sample
keys for signing. Known fixture principals are excluded from proof verification
and signing even if a source supplies records for them. A separately provisioned
`ForumAuthorityProvider` must supply complete authenticated history and signed
ACL evidence; namespace selection itself grants nothing. Receive readiness also
requires that verified forum ownership matches the configured owner.

The component remounts on a change of mode, forum or owner. This disposes prior
subscriptions, proof generations, pending work and drawer state. Need/status
high-water marks and alarm floors use separate `s3rch:squad:v2:<mode>:<forum>:<owner>`
keys. The old global cache keys are not imported into a live namespace. Cached
rows remain replay hints, never authenticated content or ownership.

No production route or environment setting selects a live namespace yet. There
are no new deployment variables in this step. The existing public demo is the
rollback/default path; returning to it mounts fresh demo state rather than
carrying live state into a fixture view.

## Remaining production gates

- Provision a fresh controlled owner and namespace, and persist the authoritative
  journal, inventories and immutable signed records in operator-owned storage.
- Bind authenticated sessions to current SEA principals. Wallet/OAuth identities
  are linked credentials, not replacements for SEA authority.
- Supply complete history, explicit witness trust and SIWE/OIDC policy. Serialize
  history changes with assignment mutations or reject stale generations at the
  sink. Preserve cancellation witnesses across key retirement.
- Connect the live wrapper, authority source and assignment client to actual
  production APIs. Register every destination through the shared journal.
- Implement configuration in the app and infra/config together, documenting
  defaults and owners. Validate actual deployment before enabling the route.
- Verify the deployed multi-client matrix in #190: chat, status, drawer records,
  needs/offers, alarm, assignment/access, recovery, revoked writers and reconnect.

The namespace and empty-state tests are consumer isolation evidence, not proof of
production history completeness, provisioning, deployment or live acceptance.

## Complete-history source lifecycle

`createForumAuthoritySource` implements the `ForumAuthorityProvider` subscription
contract around an injected, provisioned `ForumAuthorityReader`. It invalidates
before each new evaluation second, requests a fresh atomic history/ACL snapshot,
and aborts a read after 800 ms or when its generation ends. Late responses cannot
revive authority, and neither completeness horizon is extended locally. Transport
failure, missing history, timeout and backward clock movement leave access denied.
Each subscriber owns its requests and timers; unsubscribe aborts its work. The
provider invalidates the graph when the source is removed or replaced.

Witness keys, issuer pins and SIWE policy are copied and frozen for the source's
lifetime. Rotate trust by constructing a new source and replacing the provider
input, which also discards pending verification under the previous policy.

This adapter does not authenticate a transport or establish completeness. Its
reader must use a separately authenticated production service, supply atomic
complete history and ACL evidence, and honor its AbortSignal. Never plug in raw
Gun rows, browser persistence or peer-declared completeness. Signed rows still
pass through the existing recovery and authority verifiers. No production reader,
route, environment variable or deployment setting is enabled by this adapter;
those remain the production gates above.

## Same-origin snapshot transport

`createHttpForumAuthorityReader({ endpoint, squad })` supplies the reader for
`createForumAuthoritySource`. Deployment must explicitly provide an absolute-path
same-origin endpoint and a valid live Squad specification. No endpoint is enabled
by this change. The reader posts `{ version: 1, forumId, owner, evaluatedAt }` with
same-origin session credentials, no caching and redirect rejection. The service
must independently authenticate and authorize the caller and derive the namespace;
these request fields only assert the expected scope.

The response is JSON `{ version: 1, forumId, owner, evaluatedAt, snapshot }`, where
`snapshot` is the existing complete authority/history contract. Scope and evaluation
time must match exactly. Both completeness horizons must cover that time. The
reader rejects error/login responses, malformed envelopes, over 1024 ACL rows and
bodies over 4 MiB, including chunked bodies or false Content-Length. Cancellation
also stops a stalled body read. The downstream authority verifier still checks
signatures, histories and ACL semantics; a successful HTTP response is not proof
of authority or source completeness.

The 4 MiB response limit bounds transport memory and must be considered when
provisioning retained history. Exceeding it denies access; it must never trigger
truncation of revocation/cancellation evidence. Server implementation, complete
history storage/fencing, session-to-SEA mapping and production configuration remain
required before connecting this reader to a live route.

## Server snapshot service

`createForumAuthorityService` implements the matching Request/Response handler.
Its deployment-owned dependencies are a fixed live Squad, canonical origin,
trust policy, session authenticator and atomic complete-snapshot reader. It is
not installed as an application route yet. The authenticator must establish
possession of the session SEA key; neither a wallet cookie nor a pubkey in the
request proves this. The fixed namespace is never selected from request fields.

The service requires a same-origin JSON POST, bounds the request to 2 KiB and
rejects mismatched scope/evaluation time before reading authority storage. It
copies the snapshot, verifies recovery and ACL signatures, confirms the configured
forum owner, resolves the authenticated key to its current stable principal and
checks forum read access. Outsiders, cancelled members, incomplete/forged evidence
and evaluations that cross a clock boundary receive no snapshot. Responses are
uncacheable. Successful responses retain the client's 4 MiB/1024-row limits.

The reader must provide a namespace-scoped atomic history/ACL view whose history
updates participate in the assignment serialization boundary. The service cannot
prove omitted evidence or turn two independent reads into an atomic snapshot.
Its authentication and reader callbacks remain mandatory production integration
work, along with infrastructure configuration and deployed acceptance. Synthetic
signed service tests do not establish production identity or deployment readiness.

## Blob-backed session replay storage

`createBlobSquadSessionReplayStore(primaryContainer, serverNamespace)` supplies
`createSquadSessionReplayStore` with a dedicated conditional Blob slot:
`s3rch-squad-session-replay/v1/<64-hex-namespace>.json`. It is separate from
assignment journals, inventories and immutable outboxes even when they use the
same namespace. Reads bind a bounded body to its ETag; creation requires absence
and subsequent writes require the exact ETag. The slot is capped at 400,000 bytes.
Authentication, missing-container and transport failures never become an empty
replay ledger or a successful consumption.

Provision this on the trusted primary container. Do not delete, restore an older
version of, or apply lifecycle expiry to a live replay ledger while challenges
remain valid; such rollback loses consumed-ID evidence. Namespace selection comes
from server provisioning, never request input. No environment variable or Azure
resource is introduced here. Container identity/configuration wiring remains a
production rollout gate.

The existing `scripts/test-delegation-blob.sh` CI run now races independent SDK
clients consuming the same challenge, rejects stale ETags/absent-only resets, and
verifies that consumed IDs survive process and Azurite restarts. This is emulator
storage acceptance, not evidence of a deployed Azure configuration.


## SEA possession sessions

`createSquadSessions` provides a separate session protocol from wallet login.
The server issues a 60-second HS256 challenge bound to its origin, configured
forum/owner and requested SEA key. The client signs the exact challenge string
with `signForumRecord(challenge, pair)`. Exchange verifies the real SEA signature,
atomically consumes the challenge ID and issues a five-minute session token.
Token types distinguish challenges from sessions; neither crosses origin or
namespace. Public fixture keys are refused. Session authentication returns only
the proven key: the authority service must still resolve that key against current
history and check access on every request. A session is never an ACL grant.

`createSquadSessionReplayStore` supplies the single-use consumer over a dedicated
InventoryStore CAS slot shared by all instances. Used IDs survive restarts;
expired entries may be removed, but live entries are never evicted to admit a
new login. At 4096 live challenges or after four CAS conflicts, exchange fails
closed. Storage corruption/unavailability likewise denies exchange. The replay
slot must not share an assignment/inventory document and must not be reset while
challenges remain valid.

No session endpoints or cookies are installed yet. Production wiring must supply
an explicit server secret (no local fallback), dedicated durable replay storage,
same-origin challenge/exchange handlers and secure HttpOnly cookie transport.
Use `sessions.authenticate(cookieValue)` in the authority service authenticator;
do not pass the existing wallet cookie as a SEA session. Secret rotation invalidates
outstanding challenges/sessions. These dependencies must be configured in app and
infra together before enabling the live route. The existing wallet/OAuth linked
credential and recovery policy is unchanged.
