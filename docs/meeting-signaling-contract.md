# Meeting admission and signaling

s3r.ch owns the signaling route inside its existing web runtime. A declared
single-replica deployment can enable `meetingSignaling: true` in its existing
Squad pilot document. The route uses the native SEA site session and current
signed room and parent forum Check. The route is disabled by default.

## Admission

The first profile has exactly two participants. An owner-authenticated
lease contains version 1, tenant UUID, existing room ID (bounded to 512 UTF-8
bytes), opaque meeting and generation IDs, issued/expiry times in epoch
milliseconds, two distinct stable SEA principals with their current signing
keys and opaque session-generation IDs, and one designated offerer. Opaque IDs
are 128-bit lowercase hex values, never credentials. The source chooses them;
client-supplied labels do not bind a room or participant.

Maximum lease duration is 30 seconds. Future issuance, expired leases and clock
rollback fail closed. Admission must independently validate both current
sessions/key histories and current Check see on the room and its required
parents. Consent to capture and publish local tracks is separate from membership.
Neither a TURN allocation nor the browser's one-second graph is an admission
lease. Parsed data is not evidence that the source performed these checks.

The same-origin consumer must authenticate the source and bind every
response to its exact requested tenant, room, meeting, participant and session
generation before constructing the existing transport authority adapter. No
browser-supplied lease is accepted as a bearer capability. The runtime must
enforce current admission on every signaling read/write and reject revoked,
replaced or expired sessions even when a client presents an unexpired old lease.

A renewal or key/session/participant replacement creates a new generation and
a new authorized connection. It cannot mutate the existing controller's fixed
deadline. The old controller closes before replacement; old SDP/ICE, timers,
capture tracks and queued work cannot transfer to the new generation.

Each participant posts `{operation:"admit",room,peer}` to
`/api/squad/pilot/meeting` with the site session cookie and its canonical Origin.
Both independently opt in using the other participant’s canonical SEA principal.
The first authenticated participant becomes the offerer. Waiting admission returns
`{state:"waiting",expiresAt}`. Once both sessions qualify, the route returns
`{state:"ready",lease}`. The second join establishes the fixed lease. An admitted
participant presenting a replacement session retires that lease. The same origin
must handle every request for the generation. Process loss retires all generations.

## Signaling frames and ordering

Each frame contains exactly version, tenant, room, meeting, generation, sender
and recipient principals, sender current key/session generation, sequence,
kind and body. Every binding must match the admitted lease. Only the designated
offerer sends `offer`; the other participant sends `answer`. This first profile
allows one description from each peer per generation, eliminating offer glare.
Renegotiation requires a new generation rather than silently mixing exchanges.

| Kind | Body limit |
| --- | --- |
| offer / answer | SDP string, at most 65,536 UTF-8 bytes |
| candidate | Candidate string ≤2,048 bytes; nullable mid ≤64 bytes, line index 0–255, username fragment ≤256 bytes |
| end | null, end of candidates |
| leave | null, terminal teardown |

Complete JSON frames are limited to 96 KiB; the ingress transport must enforce
that byte cap before JSON parsing. Strings must be valid Unicode. Errors are
generic and never include SDP, candidate addresses or payload excerpts.

Each sender has a monotonic sequence 1–4096 within a generation. Description
precedes candidates; candidates cannot follow `end`. The receive helper retains
only the last frame. An exact duplicate of that frame is a no-op. A changed
duplicate, older replay or gap is rejected without advancing progress. A gap
requires bounded recovery from the source, not an unbounded browser backlog.
The source must cap outstanding delivery to 32 frames per direction and reject
overflow; it must never silently discard accepted messages and imply complete
delivery. Sequence exhaustion requires teardown/new admission.

Post `{operation:"send",room,peer,frame}` to write a frame. Its acknowledgement
contains the generation and accepted sequence. A retry of the last exact frame
returns the same acknowledgement. Read with
`{operation:"read",room,peer,generation,after}`. The response carries the generation
and ordered incoming frames after the acknowledged cursor. A cursor cannot commit a
frame before delivery. Each direction holds at most 32 frames and 192 KiB.
Leave or loss of the generation returns a closed/unavailable response to the peer.

## Privacy, expiry and teardown

Use authenticated encrypted transport to the declared source. Never put SDP,
ICE addresses, TURN credentials, signing secrets or admission credentials into
public Gun rows, browser persistent storage, URLs, analytics or diagnostic logs.
Transient signaling buffers are bounded by the frame/window/lease limits and
are discarded on termination. Any new durable control state belongs in the
owning service's Postgres store; this proposal introduces no storage backend.

Revocation, session/room/meeting replacement, source disconnect, invalid
binding, clock rollback, lease expiry or explicit leave closes the consumer
sequence and calls the existing transport controller's close operation. That
removes listeners, aborts work, closes the peer and stops its owned tracks.
Late responses cannot revive a closed generation. No automatic redial or
capture restart is implied by a recovered network connection.

Source-side rejection controls signaling. It cannot recall received media or
force an uncooperative remote peer to erase data. Cooperative browser teardown
is not a server-enforced guarantee that all existing peer-to-peer media stops
instantly; any stronger requirement needs an explicitly selected media-plane
enforcement design. Suspended browser timers are not a revocation mechanism.

## Scheduled fixture contract

Infra must supply two independently authenticated participant fixtures, a
non-member fixture, tenant/room scope, the actual signaling source, and explicit
setup/readiness/teardown. No login fixture or credential is fabricated here.
The source must expose sanitized readiness and expiry/revocation evidence.

Scheduled cases must cover direct transport, selected TURN relay, unavailable
relay, non-member refusal, cross-room and cross-generation attempts, revoked
sender and recipient, session replacement, duplicate/gap recovery, glare,
disconnect/expiry and teardown of both peers' tracks. Path assertions use the
selected candidate pair from the existing controller, not successful probes.
Fixtures must identify every service/browser substitution and preserve TEST
data. Registration awaits declared inputs; no manual shared-host run, reader
registration, activation, tag or publication operation is part of this work.

Unit contracts exercise frame sequencing and the HTTP handler with controlled
identity and room snapshots. The scheduled fixture still needs two independently
authenticated browsers on the real owner route and the transport consumer.
