# Signed ordinary-room chat

New rooms use canonical `room_<principal>_<nonce>` IDs. The browser signs room
ownership with its unlocked SEA key and submits it to the protected owner source
before saving the room locally. The source uses the already provisioned forum
namespace; creating a room never creates a tenant, account, namespace or parent
grant. Missing namespace configuration or identity history refuses creation.

Mine rooms initially admit only their owner. Explicit room sharing publishes the
room listing and signs see grants for current parent-forum readers, plus post
grants for its current writers. These grants last at most one hour. The interface
states that audience before confirmation. Retrying a failed operation requires
another explicit user action; writes are not automatically retried. Unsharing a
listing retains its existing meaning: it retracts discovery, not signed grants.

Every message signs its room, ID, author, body, timestamp and protocol version.
The ID includes a SHA-256-derived author prefix, so another authorized writer
cannot preempt a creator's task ID. The receive path binds the actual Gun child
key and room, verifies the current signing key, and checks current parent and
room see/post permission. Rendered rows retain immutable signature checks and
are filtered again when authority changes. Unsigned legacy rows are omitted.
The current session's SEA key selects an existing principal; no wallet fallback
or key generation is used by this path. Locked or changed keys cancel signing.

Task projection uses only admitted messages; a noncreator's signed update has
no effect. The task editor remains outside this slice. Legacy room metadata can
still be read, but it cannot establish signed chat authority.

The owner dependency is the ACL service's bounded signed-room extension to its
protected statement source. Each principal's rooms and statements share retained
row/byte quotas, with at most 32 room objects. No running service revision match
is required; the consumer refuses unsupported owner operations.

`test-room-chat-browser.ts` is a scheduled, isolated two-browser scenario for the
bundled signing/admission client. It uses synthetic identities, an in-memory
protected-source substitute, and a loopback server with browser/server cleanup.
It covers two-way signed messages, author/ID forgery, unsigned rows and signed
parent cancellation. It is not a deployed owner-source or React UI acceptance
claim. Its executable registration belongs to Infra's nightly browser adapter.
