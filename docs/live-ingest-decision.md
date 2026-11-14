# Live room ingest decision

Decision date: 2026-11-14. Scope: research issue [#448](https://github.com/FyberLabs/s3r.ch/issues/448).
This recommends a design; no live streaming service is activated by this note.

Recommend **MediaMTX**, running as a separate media process in the hyperme-sh
service plane. Start with HTTPS WHIP publishing and WebRTC/WHEP playback in
s3r.ch. Keep recording, transcoding, RTMP ingestion and HLS playback disabled in
the first slice. The recommendation follows from the protocol fit and the
smaller initial operating footprint; it is not a measured capacity comparison.

## Options

| Option | Published capabilities and licence | Decision for this slice |
| --- | --- | --- |
| MediaMTX | WebRTC, RTMP and HLS transport; HTTP or JWT authentication. Main code is MIT; packaged dependencies have their own notices. | Recommended: use the HTTP authorization hook and a separate service-plane admission adapter. Avoid an additional queue/database service. |
| LiveKit server + Ingress | Server is Apache-2.0. Ingress accepts RTMP/WHIP, uses a separate service, Redis messaging and a GStreamer processing pipeline. | Reconsider for a combined conferencing product. Its Redis dependency does not fit the current PostgreSQL-only new-state policy, whose Redis exception is SIWE challenges. |
| SRS | MIT streaming server supporting RTMP, WebRTC and HLS, with publish/play HTTP callbacks. | Viable alternative if RTMP broadcast workflows become primary. It still needs our grant, session revocation and cost-control adapter; protocol breadth alone does not remove that work. |

Sources: [MediaMTX protocols](https://github.com/bluenviron/mediamtx),
[authentication](https://mediamtx.org/docs/features/authentication),
[licences](https://mediamtx.org/docs/misc/license),
[LiveKit Ingress](https://docs.livekit.io/transport/self-hosting/ingress/),
[LiveKit server licence](https://github.com/livekit/livekit/blob/master/LICENSE),
[SRS protocols](https://github.com/ossrs/srs),
[SRS licence](https://github.com/ossrs/srs/blob/develop/LICENSE), and
[SRS callbacks](https://ossrs.io/lts/en-us/docs/v6/doc/http-callback).

## Ownership and transport

**`hyperme-sh/controlplane-core` owns the tenant streaming admission contract and
adapter**, alongside its tenant service APIs. MediaMTX remains an independent
process; media packets do not pass through the application API process.
`FyberLabs/infra` owns its runtime packaging, private control network, limits and
scheduled qualification. `FyberLabs/s3r.ch` owns the room/player UX and calls the
service contract. `hyperme-sh/acl-service` supplies current room authorization;
`hyperme-sh/turn` retains its existing relay-credential responsibility.

The initial publisher is an authenticated room member authorized to publish.
A browser or compatible encoder sends WHIP to a tenant-bound opaque stream
path; granted viewers obtain a separate read session and use WHEP. An object ID,
room URL or public Gun record never supplies authorization. s3r.ch receives no
media-server admin credential. Durable reservations and session-to-room mappings
belong in PostgreSQL. Stream buffers are ephemeral; there is no new Redis,
SQLite or filesystem metadata authority.

Require a browser-compatible H.264 stream without B-frames and Opus audio;
reject unsupported formats rather than launching an unbudgeted transcoder.
MediaMTX documents browser codec limitations and separate FFmpeg/GStreamer
re-encoding. TURN is a bounded fallback, not an implied successful connection.
The room must distinguish connecting, playing, relay unavailable and ended.
[Codec/network guidance](https://mediamtx.org/docs/features/webrtc-specific-features),
[re-encoding](https://mediamtx.org/docs/features/remuxing-reencoding-compression).

## Privacy, grants and termination

Live media is encrypted in transit, but the media server is inside the trusted
boundary and can access it. Do not label this design end-to-end encrypted.
Keep paths opaque, credentials out of URLs/logs, and all admin, metrics and debug
interfaces private. Disable anonymous publish/read and broad path permissions.
Future recordings require explicit product controls and storage through the
s3r.ch Spanopticon tenant; no direct Blob credentials belong in the web app.

The adapter derives tenant and stable SEA principal from authenticated service
identity, then checks the current room grant. A credential binds exactly one
room, stream generation, principal, action and short validity window. Atomically
reserve its capacity before accepting it; bind it to the admitted server session
to reject replay and duplicate consumption. Read permission cannot publish.
Unknown/stale identity history, unavailable Check or a mismatched tenant refuses.

Use MediaMTX's external HTTP authentication. Its documented `expireAt` response
closes an authenticated session at a finite deadline; omission leaves it
unbounded. Require a maximum 30-second expiry as a backstop, and independently
implement active-session revocation. Admission-token expiry alone is not a
revocation design. The selected runtime must prove that revoked access or loss
of current authority stops delivery within **two seconds**, including controller
failure; use private session controls and a fail-closed runtime watchdog. If
that bound cannot be enforced, private streaming remains disabled. Renewal may
require reconnecting; seamless renewal is not claimed. Already received frames
cannot be recalled. [HTTP authentication contract](https://mediamtx.org/docs/features/authentication),
[control API reference](https://mediamtx.org/docs/references/control-api).

Publisher stop, session expiry and room removal terminate the stream generation,
close its viewers and remove the player. Reconnect requires fresh authorization;
an old stream key cannot revive an ended generation. Persist idempotent stop and
reservation-release transitions, and reconcile incomplete sessions after restart.

## Initial cost envelope

These are proposed admission limits to qualify, not measured server capacities:

- One publisher per room, two live streams for the s3r.ch tenant, ten viewers per
  stream, and one hour maximum per stream generation.
- One video track at 3 Mbit/s and one audio track at 128 kbit/s; no adaptive
  rendition ladder, recording or background transcoding.
- One bounded TEST media worker, no automatic scale-out. Choose its CPU/memory
  limits from CI measurements before activation; refuse excess admission.
- Reserve a finite daily tenant transfer budget in PostgreSQL before admitting
  sessions: propose 100 GB/day initially, with a separate service-wide cap.
  Reserve worst-case session traffic, including overhead and relay allowance;
  release unused reservations only after confirmed accounting. Enforce network
  byte/rate limits as well as encoder hints and viewer counts.

At the proposed bitrate, one viewer-hour is 1.4076 GB before overhead. Twenty
viewers for an hour are 28.152 GB; a 25% transport allowance makes 35.19 GB. A
conservative extra factor of two for relayed traffic gives 70.38 GB across the
accounted paths. These are arithmetic planning bounds, not a provider bill or
measured TURN amplification. Failed/retried traffic and buffers need explicit
allowances and tests. Stop admission before reserves are exhausted, and qualify
the maximum byte overshoot during the two-second termination window.

The operator's estimate must include worker-hours at the selected regional rate,
billable transfer on every media/TURN path, PostgreSQL and monitoring. There is
no dollar quote here: the actual hosting route, regional rates and idle baseline
must be recorded in the Infra implementation before activation. A cost alert
without enforced admission and network limits is insufficient.

## Required implementation and acceptance

1. [Core #77](https://github.com/hyperme-sh/controlplane-core/issues/77): authenticated
   stream reservations, current Check, exact session binding, revocation,
   idempotent termination, accounting and PostgreSQL restart reconciliation.
2. [Infra #1311](https://github.com/FyberLabs/infra/issues/1311): isolated MediaMTX
   TEST runtime, codec/auth/expiry/control qualification, enforced resource and
   byte limits, TURN failure handling and the scheduled live-room scenario.
3. [s3r.ch #153](https://github.com/FyberLabs/s3r.ch/issues/153): honest room
   connection/TURN states. [#306](https://github.com/FyberLabs/s3r.ch/issues/306):
   publisher and room/Views player, denied viewer refusal and end handling.
   [#410](https://github.com/FyberLabs/s3r.ch/issues/410) builds discovery only from
   authorized active sessions. [#313](https://github.com/FyberLabs/s3r.ch/issues/313)
   owns later meeting/recording product behavior.

PR unit and contract checks run in CI. Deployed stream/TURN scenarios run only in
the scheduled Infra nightly batch using declared owner, room, grant and relay
fixtures; missing fixtures block. No manual shared-host runs. TEST services
follow moving channels with independently compatible patches. Record exact
artifacts for provenance; do not pin running services to commits or digests.
This decision creates no deployment, release, credential or production approval.
