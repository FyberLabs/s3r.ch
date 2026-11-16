# Private dependency measurement adapter

`lib/experiment-dependency-observer.ts` prepares a consumer for
[Core #96](https://github.com/hyperme-sh/controlplane-core/pull/96), under Core #61
and Infra #1707. It is not imported by a runtime route, application or native
experiment hook. Construction defaults to disabled and then reads no binding or
credential. No environment flag, DCR identity, provider, reader registration,
endpoint installation or runtime activation is supplied here.

The proposed first operation is an existing post-verification outbox GET. Its
measurement means **telemetry-delivery availability**, not identity/session
readiness, consent validity, or unrelated product health. Initial/coalesced cache
refreshes and pre-verification outbox activity are not relabeled. Do not add a
read just to manufacture a sample. Native injection is deferred until the #552
entry wiring is merged and accepted in CI, and remains with that owner.

## Server construction and native trust

The protected owner constructs one observer with a fixed HTTPS private relay
origin, separate 64-hex relay secret, compiled experiment and variant allowlist,
operation name, fixed record-name prefix, and UUID sampling divisor (1–10,000).
For s3r.ch the candidate labels are `landing-message`, `control`/`create`, an
owner-configured `outbox-read` operation, and prefix `s3rch-outbox-`. Deployment
must bind that operation to the matching tenant's fixed Storage URL prefix and
operation credential, with dependency kind and a 64-lowercase-hex suffix. The
relay authenticates the server, not browsers. No upstream credential is passed
by this adapter; operation access, relay authentication and the two DCR publishers
have separate credentials. Tenant/audience/source bindings are owned by deployment
and the DCRs, not inferred from strings supplied by this library.

After checking current identity, consent, retained/displayed assignment, variant
and provider policy, the native owner may call `read({variant, recordName,
current, signal})`. Derive `recordName` from the existing server consent-scoped
outbox name, never from browser input. `current()` is a trusted owner callback,
not a replacement verifier; it is checked before transport and before returning
bytes/emitting a sample. Supply a signal for immediate cancellation on native
context loss; a callback alone detects changes only at those checks. The operation
cannot grant identity, room access, or consent. The adapter accepts no browser
measurement, duration, status, action ID, arbitrary URL, header or request body.
The optional factory `createAction` dependency is for deterministic unit tests;
production uses Node's cryptographic UUIDv4 generator.

A null result means disabled, unsampled, or locally capacity-limited: no relay
request occurred, so the native caller may use its unchanged ordinary path. Any
sampled failure throws a generic error; it must not trigger a hidden direct retry
or duplicate upstream operation. The caller retains its normal operation-failure
behavior. Only actual sampled reads reach POST `/v1/observe`, with empty body and
closed attribution fields `action`, `experiment`, `variant`, `operation`, `issued`
and `target`. The UUID is generated independently of browser event IDs.

## Bounds, results and evidence

The complete caller exchange is bounded to three seconds and 64 KiB. Sampling
admissions are capped locally at 60 in a rolling minute, with eight outstanding
transports. Timed-out transports that ignore cancellation keep their slots until
they settle, so repeated calls cannot create an unbounded promise backlog. The
relay independently enforces its durable replay/rate policy. A backward server
clock stops new local sampling until time recovers.

Requests refuse redirects and request identity encoding. Encoded replies and
redirect statuses are refused before body reads. A relay response must echo the
exact UUID in `X-Experiment-Action`; absent/mismatched acknowledgement is missing
evidence, not an invented sample. Status, bounded body and bounded ETag are passed
to the existing consumer, which keeps its normal status/ETag checks. Cookies,
location and unrelated headers are not forwarded. Core reserves upstream time
inside the native deadline; deployments must preserve that headroom.

After an acknowledged operation, the server derives elapsed milliseconds from
its own monotonic clock. HTTP 5xx or incomplete/invalid acknowledged responses
are dependency failures; ordinary 401/403/404 refusals are not service failures.
Cancellation or loss of current native authority suppresses the measurement.
Missing observations cannot authorize a guardrail disable. No raw target, record
name, consent ID, identity, assignment hash, payload or credential is emitted.

`publish(rows): boolean` is a synchronous enqueue callback for a **separate,
private server DCR publisher**. Rows contain only:

- `ActionId`, `Experiment`, `Variant`;
- `Metric` (`latency_ms`, `error_rate`, `dependency_failure_rate`);
- `ObservedAt` (epoch seconds) and `Value` (measured duration or zero/one).

Rows and batches are frozen. The publisher must provide the owner's finite queue
(64 measurements), delivery deadline (three seconds), expiry (60 seconds), no
retries, and separate server-source DCR identity. Return false on full/stopped;
throwing or refusing enqueue does not change an already completed read. Do not
perform synchronous network work in the callback, send through the measured
analytics outbox, or expose it to the browser. This adapter does not implement
Azure credential acquisition or claim DCR delivery; that private publisher and
its deployment binding remain owner prerequisites. The platform independently
observes its upstream exchange and uses its own DCR; it does not accept server
reported timing as its measurement.

## Validation and remaining integration

Unit tests use explicit HTTP and publisher substitutes. They cover default-off,
UUID sampling, fixed request shape, real elapsed timing, status/ETag preservation,
label/record refusal, context replacement, missing acknowledgement, response and
encoding limits, cancellation, three-second deadline, local admission bounds and
publisher failures. They do not establish live relay, DCR or native acceptance.

Core #61 remains open until reviewed producer/relay contracts, the protected
publisher, native post-verification injection and actual-operation CI acceptance
are complete. Real owner/provider scenarios belong only to Infra's scheduled
batch with declared fixtures. No shared validation is manually run here. Version
222 is reserved after the native owner's 221; source readiness is not installation.
