# Native stream authority binding

`lib/stream-authority-server.ts` binds Core's optional stream relay to the existing
SEA proof-session verifier and protected statement source. It verifies native
signed room ownership and grants on every call. No public Gun completeness,
caller-selected principal or cached allow decision supplies authority.

Identity requests carry an existing native SEA session as a bearer over the
private Core-to-owner channel. Core receives a sealed subject containing the SEA
key, native session identifier and expiry. Each later Check verifies that seal,
resolves the current canonical principal, requires the same current writer key,
and checks parent-forum membership plus direct room read authority; publishing
also requires both parent-forum and room post authority. Rotation, cancellation, expired sessions,
stale snapshots, mismatched tenants and unavailable sources refuse access. The
opaque subject prevents a previous session from silently borrowing a newer one.
Its value is private credential material and must never enter diagnostics.

`node --import tsx scripts/stream-authority.ts PRIVATE_CONFIG` is an explicit,
uninstalled HTTPS process bound to numeric loopback. Configuration and referenced
TLS/signing files must be private, owned regular files. It uses separate session,
statement-source, private service and Ed25519 response credentials. There is no
Next route, frontend entry, new login flow or default startup hook. A missing or
disabled configuration starts nothing. No provisioning or public deployment is
part of this change.

Infra #1311 owns the disposable source/room/participant/relay fixture, current
main composition and scheduled scenarios. The unit tests use real SEA and signed
Check cryptography with named HTTP/replay-storage doubles; they do not qualify a
deployed session. Direct P2P remains preferred. Core's 32,000,000,000-byte daily
fallback reservation ceiling does not become a recording upload path or a paid
fallback offer.


Concurrent requests queued before a source read starts share that fresh snapshot
and native graph verification. Requests arriving after it starts wait for a new
read. Completed snapshots and allow decisions are never cached. A clock rollover
requires a new native read within the same 650 ms request deadline. Core uses a
700 ms authority deadline inside its unchanged controller/watchdog shutdown bounds.
