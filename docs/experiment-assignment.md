# Experiment assignment adapter

`createExperimentState` is the server-only assignment adapter for #337. It accepts
an authenticated SEA principal from the session verifier, the request cookie
header, and a bounded set of active experiment definitions. Its provider callback
receives a keyed assignment hash. Assignment remains stable across release versions and colors.

The adapter emits a random UUID in `__Host-s3rch-experiment-id` and authenticated
cohort state in `__Host-s3rch-experiments`. Both cookies use Secure, HttpOnly,
SameSite=Lax and Path=/ with no Domain. The signing/hash secret must be random,
at least 32 bytes and shared across web instances for the assignment window.
For a planned secret rotation, supply up to three `previousSecrets` shared by all
instances. Existing signed state is verified against those keys and rewritten
with the current key. Active assignment hashes stay unchanged, while new
experiments use the current key. Account binding is checked with the key that
verified the old state, so rotation never transfers another account's cohort.
Keep prior verification keys for the required assignment retention window;
removing a key invalidates cookies that have not yet been rewritten.
The legacy adapter token has a one-year ceiling. Product routes clamp every
returned cookie to the remaining 24-hour consent window before setting it.

An anonymous cohort survives the first sign-in. Later experiments use the verified
SEA identity's keyed hash; retained experiments keep their original cohort hash.
Logout or switching accounts discards the previous person's assignments. Removed
experiments are pruned, and at most eight active experiments fit the cookie budget.
An expired, invalid or unverifiable state token starts fresh state.

A provider error or unknown variant returns the compiled control without saving
an assignment. A failed guardrail overrides the returned variant to control while
retaining the cohort for attribution. The caller supplies the authoritative shared
guardrail result. This library does not collect metrics or change a deployment.

Evaluation does not emit events. Use the first-party event adapter only when a
response actually shows a variant or the configured conversion occurs. Experiment
and variant names are configuration slugs, never customer content. The SEA key,
assignment UUID, cookies, request headers and raw errors never enter event payloads.

The default-off product route is `/api/experiments`; the landing hero consumes
its signed decisions. Shared guardrail control belongs to Core #49.

## OpenFeature and GrowthBook provider

`createExperimentProvider` evaluates through the OpenFeature server SDK and its
GrowthBook provider. Give the adapter one dedicated OpenFeature domain and an
operator-configured public Ed25519 key. The signer belongs to the control plane;
the web process receives only its public key. No key is accepted from a request.

`refresh(raw, signature)` verifies a detached base64url Ed25519 signature over the
exact UTF-8 JSON bytes before parsing. The bounded payload has exactly these
fields: `version: 1`, `audience: "s3r.ch"`, positive monotonic `sequence`, epoch-second
`issuedAt` and `expiresAt`, and `experiments`. Validity is at most 300 seconds.
Each experiment has `key`, `control`, `variants`, `weights` (summing to one), and
`disabled`. Extra targeting attributes and demographic conditions are refused.

A bad signature, malformed payload, stale sequence or failed refresh retains the
last valid configuration until its expiry. Before the first payload or after
expiry, definitions are empty and evaluation falls back to the caller's compiled
control. A signed disable supplies the shared guardrail override to the state
adapter. The provider itself does not collect or aggregate metrics.

Only a keyed assignment hash enters GrowthBook's targeting context. The SDK uses
an in-memory payload with networking, streaming and analytics callbacks absent.
The application controls first-party exposure/conversion emission separately.

Payload signing/delivery and the shared guardrail controller are owned by Core;
the consumer receives only public verification keys and scoped storage keys.

## Named conversions

`createExperimentEmitter` and `createExperimentTelemetry` accept a trusted
`ExperimentEmissionPolicy`: destination `supportedEventTypes` and a `metrics`
map from experiment key to allowed metric slugs. Configuration is copied when
the adapter is created. Recreate it when trusted configuration changes; never
construct the policy from browser event fields.

A named conversion uses `experiment.conversion.v2`, a required `conversion_key`,
and a separately supplied action UUID. Persist that UUID with the action and
reuse it across retries and sinks. The Application Insights adapter adds it as
`event_id` in custom properties. Downstream queries must deduplicate by that ID;
ingestion itself is not exactly-once. The assignment UUID is never emitted.

An absent v2 advertisement, missing action ID or unconfigured metric prevents
emission. Legacy exposure and conversion v1 retain their strict payload shape;
never downgrade v2 by dropping its metric. The product route retains actions in its conditional durable outbox before
delivery.

## Signed tenant-cache delivery

`createCachedExperimentProvider` reads `cache/experiments-v1-s3rch` through an
operator-configured `RecordStore` and pinned Ed25519 public key. Its envelope has
only `payload` and `signature`; the exact payload bytes still pass the existing
signature, audience, sequence and expiry checks. Cache credentials cannot authorize
flags. The Spanopticon publisher uses a separate publication sequence so signature
renewal does not change the private operator policy revision.

Call `refresh()` before preparing an experiment response. Concurrent callers share
one read, reads are throttled to 30 seconds, and each attempt has a three-second
deadline. Failed or malformed reads keep the last valid payload only until its
signed expiry; missing/expired definitions require compiled control. Closing the
adapter aborts pending transport and prevents late activation. No background timer is installed by constructing it. The product route calls
refresh before evaluation/reporting.


## Assignment hash-key versions

Each new assignment retains an opaque, domain-separated identifier of its hashing
key. `assignmentKeyVersion(key)` returns that identifier for server-side attribution,
or `null` for older assignments whose key version was never recorded. It is not
added to the strict exposure/conversion schemas.

The independently signed `__Host-s3rch-experiment-key-versions` companion cookie
binds versions to the anonymous identifier and each exact experiment/hash pair.
The existing cohort cookie format is unchanged, so older instances still accept
and preserve cohorts during rolling updates. Browsers retain the companion when
an older instance rewrites the original two cookies. New instances re-sign all
cookies with the current secret while keeping each assignment's original version.
Missing, malformed or expired metadata stays unknown rather than guessing the
original key from the cookie's current signer. Logout/account switch and pruning
remove associated metadata. All cookies are host-only, Secure and HttpOnly.


## Per-event privacy permission

An assignment hash is pseudonymous data. Both emitters refuse all events unless
`ExperimentEmissionPolicy.privacy` returns current server-held consent, a future
`retentionUntil` timestamp in epoch milliseconds, and `deletionRequested: false`.
The synchronous callback receives only the validated event payload and must read
trusted current state for that assignment. Missing, expired, unavailable or
malformed permission denies emission. Do not use a browser claim or a cached
process-wide consent boolean. Capability and metric configuration is captured,
but the privacy decision is read anew for every event. The Azure adapter rechecks
it after asynchronous client initialization, immediately before dispatch.

No privacy authority is installed by default, including the process adapter.
This gate prevents new emissions; it does not delete previously ingested records.
Tenant retention settings, deletion propagation to every sink, and verified
session/consent wiring must be completed before enabling route telemetry.


## Product routes and scheduled handoff

`S3RCH_EXPERIMENTS_ENABLED=1` enables the compiled `landing-message` experiment:
control retains the existing heading; `create` shows the alternate heading.
The only named conversion is `feed_opened`, emitted by an ordinary primary click
on the experimental public-feed link after a verified SEA sign-in. The link
starts a keepalive POST immediately and navigates within 1.5 seconds. Modified
clicks and anonymous browsing retain ordinary link behavior. Existing 18+ sign-in
confirmation and linked credential policies are unchanged.

The server verifies the existing shared SEA session using
`createIdentityTokenVerifier`; it does not issue another identity token. The SEA
public key is used only for new signed-in assignments and is never included in
analytics. Wallet and Keycloak claims cannot substitute for that key. Invalid or
expired SEA cookies refuse evaluation/reporting rather than becoming anonymous.
Signed-in display validity ends at the earliest native session, configuration or
consent expiry. Session-change notifications clear the client display promptly.

Consent is explicit and expires in 24 hours. Withdrawal remains available when
experiments are disabled or the SEA session is unavailable. The durable record
holds a revocation tombstone until consent expiry so stale requests cannot
resume sending. Per-sink conditional claims prevent concurrent dispatch, expire
after 30 seconds if a process dies, and retain stable action IDs. At 64 rows,
completed work is reclaimed before admitting a new action; pending work is never
evicted. Recent completed IDs suppress retries. Older retried IDs or ambiguous
transport completions may recur, so downstream queries must deduplicate IDs.
Core retention workers remove expired private records. Withdrawal removes
pending events; it does not claim to erase already ingested analytics.

See [configuration.md](configuration.md) for the explicit tenant, origin, public
key, separate cache/outbox credentials and conversion-capability settings.
Keep flag-signing, GrowthBook administration, trusted guardrail publication,
metrics-query and registry credentials outside this process. The event route
accepts no raw identity, tenant override or client error-total fields. Browser
reports never authorize a guardrail disable.

`scripts/test-experiment-browser.mjs` is restricted to Infra's scheduled nightly,
this repository's master branch and suite `flags-s3rch-browser`. It reuses the
closed startup browser fixture, including the declared existing SEA record and
real linked-provider form steps. The key is staged only in a fresh isolated
browser, then the product's own linked-login and SEA proof flows establish the
session. No bearer token, authenticated storage state, new identity or shared
TEST reset is substituted. The harness checks anonymous visible exposure,
SEA sign-in continuity, named feed conversion and refresh continuity, then
confirms withdrawal. Private IDs are written only to an exclusive mode-0600
observations file; only case outcomes reach stdout.

Infra #923 owns registration, setup/readiness/cleanup, isolated first-party
sink queries, controlled process restart, expiry/recovery and combined
cross-tenant scenarios. Unavailable prerequisites are blocked, not successful
skips. No browser suite or nightly is manually dispatched.
