# Native private dependency observations

Core #61's s3r.ch consumer now wraps the existing post-verification outbox work.
This follows the reviewed Hypermesh #89 and Portal #141 patterns, reusing the
s3r.ch #579 dependency adapter. It measures actual telemetry-delivery dependency
reads, not product/session-service availability. No additional read is added.
All activation remains disabled unless the separate measurement switch is set
by deployment owners; this change supplies no credentials, installations or
reader registrations.

The runtime first validates privacy, retained/displayed assignment, known variant,
conversion schema, sink support and current provider policy. Only then does its
existing retain/flush path enter AsyncLocalStorage scope. Initial consent checks,
evaluation/cache refresh, erase and unverified requests remain unmeasured. The
application additionally checks request cancellation, SEA token expiry and the
existing terminal-work binding. It does not add or change login/session authority.

Inside scope, the record adapter replaces only the existing outbox GET with the
private relay operation `s3rch-outbox-read`; target is the server-derived opaque
record suffix. Experiment `landing-message` and variants `control`/`create` are
compiled. No event ID, identity, consent token, terminal binding or browser metric
is used as an action label. The observer generates independent UUIDs and uses the
existing sampling, admission and response bounds documented in
[experiment-dependency-observer.md](experiment-dependency-observer.md).
Unsampled reads remain direct; a sampled error never falls back or retries direct.
The adapter owns the sampled deadline; the storage deadline applies only to direct
requests. Genuine external request cancellation is forwarded independently.

Measurements are staged per native operation. The returned outbox ledger must pass
its existing schema and terminal-binding checks; any invalid or revoked ledger
invalidates every staged row for that operation. Genuine dependency failure before
a ledger can be returned is measured only while the previously verified context is
still current. Scope exit rechecks context before releasing rows. This is not a
new proof of fresh remote consent during an unavailable storage request.

## Separate private publication

The private Azure publisher never uses the analytics sinks or measured outbox.
It accepts only closed three-row batches (latency/error/dependency failure), with
one action/experiment/variant/time, and no tenant/audience/source/target fields.
Deployment's dedicated DCR/identity binds server source and tenant; code cannot
verify the remote DCR transform or IAM scope, which remain owner acceptance gates.

Queue admission is synchronous and bounded to 64 waiting batches plus one active
batch. Each delivery uses a three-second abort signal; queued rows older than 60
seconds are dropped. Transport failures are discarded without a retry through the
product outbox and cannot change the native result. Closing clears the queue/token
and aborts the active delivery. An injected transport that ignores abort can keep
one delivery pending; it cannot create an unbounded queue. Real transport timeout
and Azure ingestion remain scheduled provider acceptance, not unit-test claims.

Relay and ingestion credentials come from distinct absolute, private, same-UID,
single-link regular files. They cannot equal each other, the identity session
secret, current/previous experiment signing keys, or cache/outbox storage keys.
Only HTTPS private relay and Azure Monitor ingestion origins are accepted. The
configuration reference lists the disabled-by-default deployment bindings.
No request/browser endpoint accepts rows or publisher credentials.

## Validation and remaining acceptance

Native application units exercise real signing, cookies, retained/displayed
assignment and the actual outbox operation with explicit HTTP/relay/Azure substitutes.
They cover disabled/no-observation, unverified display refusal, normal delivery,
revoked/invalid ledger suppression and acknowledged dependency failures. Additional
units cover scope isolation, private credential files, prior signing-key separation,
bounded publication, ETags/no direct retry and adapter-owned stalled-read deadlines.
These are source contracts, not real Azure/provider or hosted browser acceptance.
Core #61 remains open for remaining producer/session-service consumers and scheduled
composition/activation evidence owned with Infra #1707/#1715. Reader cases remain
unregistered and all rollout switches retain their existing defaults.
