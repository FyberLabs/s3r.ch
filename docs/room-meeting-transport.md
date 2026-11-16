# Room meeting transport

Issue #153's `controlMeetingTransport` owns one WebRTC peer connection and its
dedicated local capture tracks. It is not mounted in the room UI. Admission and
authenticated signaling are tracked in
[issue #527](https://github.com/FyberLabs/s3r.ch/issues/527). An
[inactive contract proposal](meeting-signaling-contract.md) now supplies bounded
wire validators and sequencing tests; it is not authenticated admission or a
runtime signaling adapter.

The eventual signaling adapter must bind both participants to the room and
meeting, check current admission, supply a fixed expiry, and synchronously notify
revocation or identity changes. The controller checks admission before and after
asynchronous statistics reads and at most every second while the tab is running.
Suspended tabs cannot provide a real-time revocation guarantee; the signaling
owner must define enforcement independently of browser timers. Renewal requires
a new authorized connection; changing the input deadline does not renew one.
The one-second room graph and TURN credentials are not durable admission.

Only `connectionState === "connected"` produces a connected state. The path is
derived from transport `selectedCandidatePairId` and its successful pair's local
and remote candidates. A relay candidate produces `relayed`; complete known
non-relay candidates produce `direct`; incomplete statistics remain `unknown`.
An arbitrary successful candidate pair is not proof of the selected path.
See the [WebRTC statistics specification](https://www.w3.org/TR/webrtc-stats/).

Revocation, expiry, clock rollback, or explicit close removes listeners, closes
the peer and stops all owned tracks. Do not share those tracks with another
connection. Late statistics cannot restore a closed connection. Observer states
contain no SDP, ICE addresses, TURN credentials or participant identifiers.

Focused mock tests cover path selection and authority teardown. Live signaling,
TURN allocation status UI, mesh negotiation and scheduled two-browser coverage
remain required before #153 is complete. No browser or shared-host integration
run is invoked locally.
