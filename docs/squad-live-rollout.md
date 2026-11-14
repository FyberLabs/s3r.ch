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

## HTTPS cookie handlers and service composition

`createSquadHttpServices` constructs session and authority handlers from the same
fixed Squad/origin configuration. Its challenge, exchange and logout handlers
require same-origin JSON POSTs and bounded request bodies. Challenge issuance sets
an HttpOnly challenge cookie; exchange requires that exact cookie as well as the
SEA signature, so a proof from another browser cannot establish a session.

Successful exchange sets `__Host-s3rch-squad-session` with Secure, HttpOnly,
SameSite=Strict, Path=/ and a five-minute Max-Age. The token is not returned in
JSON. The challenge cookie has a 60-second lifetime and is cleared after exchange.
Duplicate session cookies fail authentication. Logout clears both cookies; it
removes this browser's session, not an independently copied bearer token, which
remains bounded by expiry and per-request current-key/ACL checks.

The composition injects the cookie authenticator directly into the authority
service. A valid cookie alone does not make missing or revoked authority valid.
All responses are no-store. HTTPS is mandatory for these handlers, including a
locally deployed acceptance environment. No Next route is registered by this
factory: production must still supply the explicit secret, dedicated durable
replay store and atomic complete-history reader and wire those through infra.

## Browser source activation and invalidation

`createSquadBrowserSource` combines the authority HTTP reader, per-second refresh
lifecycle and assignment client under a fixed live Squad. It starts disabled and
makes no network calls until explicitly activated after the session exchange.
Activation permits transport only; the server and authority provider still verify
current history, signatures and permissions. No source is mounted automatically.

On logout, key change or teardown, call `deactivate` synchronously before awaiting
network cleanup. It withdraws subscribed authority, stops refresh timers and aborts
in-flight transports. Generation checks reject late assignment/authority results,
including across reactivation. `dispose` permanently disables the source. Every
assignment call must match the configured owner/forum, and production requests use
same-origin credentials, no-store and redirect rejection.

Aborting transport cannot undo a mutation already committed by the server. After
a lost response, reopen the saved operation through a fresh authenticated request.
UI integration must still coordinate session renewal, selected-key changes and
provider mounting; production routes, config and deployed acceptance remain open.


## Atomic authority snapshot storage

`createForumAuthoritySnapshotStore` stores the fixed Squad scope and complete
history/ACL snapshot in one conditional document. Its trusted importer initializes
only an absent slot and replaces only the expected ETag. Concurrent writers must
reload and reconcile after a conflict; they cannot silently overwrite one another.
The reader returns both histories and ACL evidence from that one storage snapshot
and refuses evaluation beyond either supplied completeness horizon. It never
advances those horizons based on the local clock.

Updates retain every prior ACL row, global link and account's rotation, revocation
and genesis binding records, and cannot regress either completeness horizon.
Retention uses conservative exact JSON record comparison; reordered record fields
may be rejected and must preserve their stored representation. Array ordering can
change. Old cancellation/recovery evidence is not discarded merely because a newer
row exists. Capacity fails closed rather than compacting records: 4 MiB total,
1024 ACL rows, 128 accounts and 1024 entries per history list.

`createBlobForumAuthorityStore` backs this document at
`s3rch-forum-authority/v1/<server-derived-64-hex-namespace>.json` in the trusted
primary container. The existing Azurite acceptance run tests independent-client
CAS races, absent-only initialization and complete snapshot reads after restart.

This store preserves supplied evidence; it does not authenticate the importer or
prove completeness, signatures or ownership. The existing authority verifier must
still check all evidence. Do not populate it from arbitrary Gun data or a pair of
independently read history/ACL sources. Production ingestion must deliver a complete
atomic source view. Assignment writes and history updates are not yet connected to
this shared commit boundary; live enablement must wait for that integration and
for app/infra provisioning. No new production setting or endpoint is enabled here.

## Browser SEA session transport

`createSquadSessionClient` performs challenge/exchange/logout against explicitly
configured same-origin HTTPS endpoints. Before signing a challenge with the
selected SEA pair, it checks the challenge token type, origin, forum, owner, key,
nonce and short validity interval. These decoded claims constrain signing intent;
the server still verifies the challenge MAC, browser cookie and single-use proof.
The client snapshots the selected pair before awaiting network responses.

Responses are bounded to 8 KiB, redirects are refused and requests are no-store.
The exchange returns a boolean; bearer tokens stay in HttpOnly cookies and are
never copied to localStorage or returned to application JavaScript. One client
instance refuses overlapping login/logout operations. Aborted or invalid exchanges
fail closed. A network error after exchange may still mean the server set a cookie;
callers must use verified authority reads, not the boolean alone, as access proof.

UI wiring must invalidate authority when the selected key changes or logout starts,
handle failed/expired sessions, and request a fresh sign-in when needed. This helper
does not yet mount a live UI, register an endpoint or configure production storage.


## Shared assignment/history commit boundary

`createSquadCommitStore` now combines the assignment journal and complete recovery
history in one primary conditional document. `createSquadRuntimeRequest` opens a
fresh pinned journal/history view for each authenticated runtime request. Reads
and proof checks use that view; every mutation compares the same underlying ETag.
If history or another journal writer advances it, the old view cannot commit and
must be discarded. Lost acknowledgements poison the view too; reopen the durable
operation on a new request rather than retrying on stale verified evidence.

Authenticated history import uses `updateHistory(expectedETag, history)`. It
preserves recovery/link evidence and horizons using the snapshot store's rules,
and increments the journal revision in the same commit. Clients holding an old
assignment revision must reload. Conversely, a journal commit invalidates a
history import's old ETag. The combined source's `read` supplies authority evidence
from that same document. No independent legacy history lookup may be substituted.

`createBlobSquadCommitStore` uses the dedicated primary-container path
`s3rch-squad-commit/v1/<namespace>.json`, capped at 6 MiB; existing 2 MiB journal
and 4 MiB authority-validation limits still apply inside it. The separate journal
and snapshot adapters remain available for existing tests/import tooling but are
not an alternative shared live commit boundary. Provision the combined document
explicitly from an authenticated consistent source; missing state never resets.

The runtime race test verifies that a history update after owner verification
prevents an assignment claim. Azurite tests verify cross-client history fencing
and combined state after restart. These establish the storage/runtime boundary,
not production importer completeness, session authorization for mutation routes,
or deployed acceptance. Production routes must open a new runtime request per
call and connect every writer to this combined document before enabling live use.

## Authenticated assignment HTTP service

`createSquadAssignmentService` implements the existing assignment client's read,
start, resume, abort, child-read and signed child-write operations. Deployment fixes
the HTTPS origin, Squad, combined source, signer and immutable operation stores.
`createSquadHttpServices` can compose it with the SEA cookie authenticator and the
same trust policy/clock as the authority service. No route is enabled by default.

Each request validates same-origin JSON, bounded body size and an exact action
schema before opening a fresh combined history/journal view. The actor comes from
resolving the authenticated SEA key against that view; request fields cannot
choose an actor or namespace. Owner operations require the resolved owner. Child
operations retain the runtime's direct read/write and signature checks. Assignment
reads return only the consumer view, not child content or full authority history.

The request stops if its evaluation second changes rather than carrying a key's
old principal resolution into a later evaluation. Concurrent history/journal
changes still fence writes through the shared ETag. A conflict, lost response or
partial assignment is recovered with a fresh authenticated request and the saved
operation ID. Completion remains based on durable cancellation and replacement
evidence, never status metadata. Mutation routes and production provisioning must
still supply this service with trusted stores and an authenticated history importer.

## Live client connection wrapper

`LiveSquadForum` composes the actual live forum with the authority provider and
`createSquadConnection`. It accepts a locally unlocked SEA pair and explicit
Squad/trust/endpoint configuration. Never pass private pairs through server props
or deployment configuration. The public demo route does not mount this component.

The connection serializes sign-in/logout, disables authority synchronously before
key changes or disconnect, aborts superseded exchanges and ignores stale success.
It activates transport only after successful exchange. Session exchanges time out after
15 seconds, and the local connection expires conservatively four minutes from
sign-in start, before the five-minute server token limit. Reconnection requires a
fresh user/session action; private keys are not retained for automatic renewal.

The connection remounts on namespace, endpoint or trust-policy changes. Key
changes, including a null pair on lock/logout, go through the same serialized
connection; null explicitly requests server logout. The forum content remounts
on key changes to clear local view state. Disconnect remains available to retry
failed network logout even while locally disconnected. Each
layout-effect setup constructs a fresh connection, including React Strict Mode replay;
unmount disposes it. The initial/server-rendered view is empty and disconnected.
A connected session is not itself proof of ACL access: the authority provider and
server still verify evidence. Production route registration, history ingestion,
configuration and deployed multi-client acceptance remain separate gates.

## Controlled primary-ledger deployment

The synthetic pilot uses a separately provisioned, authoritative ledger, not an
import of arbitrary Gun/Panopticon history. All pilot history admissions and
assignment/destination mutations use the same primary conditional document.
`authoritative-ledger` mode supplies completeness only for the second in which a
fresh primary read began and completed. The pinned view expires on the next
second, and any concurrent history admission fences a mutation by ETag. Reads do
not rewrite horizons/revisions. The existing default `imported-snapshot` mode
continues to require the source's authenticated completeness horizon. Never enable
ledger mode on a replica, peer cache, partial history or externally writable
namespace. Public fixture accounts are refused in ledger mode.

`/feed/squad/live` and `/api/squad/pilot/{session/*,authority,assignment/*}` are
mounted separately from `/feed/squad` and `/forum`. The session key comes from the
existing locally unlocked identity, not a server prop. The deployment JSON's
public projection includes only scope, origin, trust policy and endpoint paths.
The session secret stays on the server. The owner SEA signing pair stays in the browser or operator client; assignment records are signed there and verified by the server. The readiness
endpoint `/api/squad/pilot/health` verifies a fresh primary read and signed owner
authority; 404 means disabled and 503 means unavailable. It returns no history or
credentials. Readiness is not deployed multi-client acceptance.

Infra owns `squad_pilot_secret_name` in `config/environments/production.yaml` and
renders its Key Vault reference into `S3RCH_SQUAD_PILOT`. Empty disables the pilot.
The dedicated private `s3rch-squad-pilot` container has its own system-identity
Blob Data Contributor grant. Infra also supplies `S3RCH_SQUAD_BLOB_ACCOUNT` and
`S3RCH_SQUAD_BLOB_CONTAINER`. Application access uses managed identity only; it
cannot fall back to Azure CLI, shared keys, account-link storage or local files.

Operator preparation uses `npx tsx scripts/squad-pilot.ts prepare NEW_PRIVATE_DIR
https://s3r.ch`. It creates random SEA identities and a separate witness key,
0600 files inside a new 0700 directory, and no remote state. `deployment.json`
is the Key Vault secret value; `operator.json` contains synthetic agent and
witness private material and must remain in independent operator custody, never
in the app container or public config. The initial policy allows Base Sepolia
wallet proofs for the exact origin and no OIDC issuer. Do not claim Panopticon
credential acceptance from that policy.

`provision DIRECTORY ACCOUNT CONTAINER` conditionally creates the complete
ledger only when absent, including registered owner-held child destinations and
signed grants. Use an explicitly selected Azure subscription via
`AZURE_SUBSCRIPTION_ID` and a container-scoped operator credential. No existing
ledger is reset. `verify DIRECTORY ACCOUNT CONTAINER` rereads primary storage and
verifies authority. `admit-history DIRECTORY ACCOUNT CONTAINER HISTORY_JSON`
is a trusted operator admission, not a public import endpoint: reconcile the
complete candidate with current ledger state first. Prior evidence cannot be
removed and concurrent changes require explicit reconciliation. Signature/key
verification still controls runtime authority; an operator can freeze the pilot
by admitting conflicting evidence and cannot treat a successful storage write as
successful recovery. CLI errors omit secret values.

Provision before setting the Key Vault reference and check readiness after the
exact tested image is deployed. To roll back access, empty the configured secret
name and redeploy/apply settings; retain the ledger, replay state, immutable
outboxes and historical public witness keys. Never restore an older ledger or
rotate the namespace as an error-recovery shortcut. Witness rotation must retain
historical keys and their issuance intervals; do not reuse a kid/key or extend an
old issuance window. Missing or expired evidence denies access.

The emulator acceptance now exercises the actual pilot server composition with
separate session clients, real SEA challenge signatures, assignment cancellation
and replacement, logout denial and replay after emulator/process restart. Those
results remain distinct from Azure provisioning, image deployment, browser
acceptance and provider credential/recovery acceptance.

The explicit live HTTP acceptance command is
`npx tsx scripts/test-squad-pilot-live.ts PRIVATE_DIRECTORY reassign`. It changes
the synthetic Squad's assignment from the first agent to the second, persists its
operation ID for recovery, checks durable child writes, old-writer denial,
reconnect and logout with independent cookie jars, and emits no credentials.
Use only the isolated pilot namespace. It is not a browser or recovery test.

A rotation regression currently confirms that retained retired-key ownership rows
are excluded by the verifier even when current-key ownership resolves correctly.
The higher-level runtime still rejects all diagnostics, so reissuing records
alone does not yet restore operation after rotation. Do not delete the old rows
to work around this: the rotation acceptance gate remains pending.

## Native browser statement admission

The configured pilot now exposes `statementEndpoint` alongside its authority
endpoint. The live composer uses the authenticated SEA session to submit signed
statement ownership and grants to current forum readers. Keys remain in the
browser. The protected source independently checks the principal, forum access,
current key, complete history, quotas and atomic append fence.

The browser verifies a fresh snapshot before signing and again after admission;
HTTP success alone does not permit a Gun write. The final signed write also
requires current forum read/post access and statement ownership. Disconnect,
key changes, expiry and replaced providers invalidate pending work. A retained
unsent draft keeps its ID for five minutes so retrying an uncertain response
does not allocate a new object. Reader grants expire one hour after the original
statement timestamp; retries do not extend them.

The CI browser contract uses isolated synthetic identities and the real browser
WebCrypto signer, HTTP reader and protected admission handler. It does not stage
storage credentials, enable a live namespace, or establish deployed acceptance.
