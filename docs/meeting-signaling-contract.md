# Meeting admission and signaling contract proposal

Status: inactive consumer proposal for #527, not a deployed or accepted service
contract. The validators in `lib/meeting-signaling-contract.ts` are not imported
by a route, room UI, or the transport controller. They validate shape, binding
and ordering only. They do not authenticate any response, resolve a session,
check room access, or create `MeetingAuthority`.

## Ownership and remaining decisions

s3r.ch owns the consumer proposal and existing `controlMeetingTransport`.
The admission/signaling runtime owner and endpoint have not been declared.
Infra has been asked to coordinate the scheduled two-browser fixture and identify
any existing service contract. This proposal does not select a new control plane
or provision a service. Before #527 can close, its runtime owner must accept or
revise these limits, authentication profile, admission/revocation implementation
and fixture contract. #153 remains open until that implementation, UI and CI
scenario are complete. Missing owner inputs are unavailable states, never an
invitation to fabricate grants, identities or a signaling URL.

## Admission

The proposed first profile has exactly two participants. An owner-authenticated
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

The eventual same-origin consumer must authenticate the source and bind every
response to its exact requested tenant, room, meeting, participant and session
generation before constructing the existing transport authority adapter. No
browser-supplied lease is accepted as a bearer capability. The runtime must
enforce current admission on every signaling read/write and reject revoked,
replaced or expired sessions even when a client presents an unexpired old lease.

A renewal or key/session/participant replacement creates a new generation and
a new authorized connection. It cannot mutate the existing controller's fixed
deadline. The old controller closes before replacement; old SDP/ICE, timers,
capture tracks and queued work cannot transfer to the new generation.

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

The source must provide idempotent write acknowledgement bound to generation,
sender, sequence and payload, plus resumable bounded reads after the last
acknowledged sequence. Transport encoding, endpoint paths, acknowledgement
schema and service ownership remain owner decisions, not implemented APIs here.

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

The current unit tests use synthetic lease/frame data, existing SEA public-key shape
validation and an injected clock. They prove only parser and sequencing
properties. They are not evidence of authenticated admission, WebRTC exchange,
TURN routing, runtime revocation, deployment or two-browser acceptance.
