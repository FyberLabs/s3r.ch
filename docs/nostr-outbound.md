# Explicit Nostr publishing (#455)

An owner can choose **Post to Nostr**, then **Confirm Nostr**, on an owned native
post. The existing authenticated `/api/outbound` route checks the current SEA
owner and passes it to the server-only adapter. Sharing, importing, grants, and
background scheduling never invoke this adapter.

All three server-only settings are required; no signer or relay is enabled by default:

- `NOSTR_OUTBOUND_OWNER`: exact current SEA public key permitted to use this signer.
- `NOSTR_SIGNER_KEY`: 32-byte lowercase hexadecimal secp256k1 secret. Never put it
  in a `NEXT_PUBLIC_*` variable, a browser bundle, Gun, or a post.
- `NOSTR_OUTBOUND_RELAY`: operator-selected `wss://` endpoint, without credentials,
  query or fragment. This is a trusted deployment setting, never request input.

The signer is scoped to one owner; another authenticated owner cannot use it.
Missing or invalid configuration refuses before opening a connection. This is
explicit operator provisioning, not a claim that a SEA signature proves ownership
of a Nostr key. No credentials are provisioned or existing services activated by
this source change. Future multi-owner credential custody needs its own contract.

The adapter publishes a kind-1 note using [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).
Only the trimmed body is copied; private links and metadata are excluded. Notes
are capped at 16 KiB UTF-8, replies at 4,096 characters and 32 frames, and the
connection at ten seconds. The server uses `ws` with bounded payloads, compression
disabled, and forced termination on completion; it does not wait for a relay close
handshake. Temporary key buffers are erased after use; the
operator-owned environment secret remains in server configuration.

Success requires a matching `OK` event ID and boolean `true` after sending the
event. Rejection, close, abort, malformed data, or missing acknowledgement fail
without exposing raw relay error text. Timeout may mean the relay accepted the
note but its reply was lost; retrying may publish another note. A relay's
acknowledgement is not proof of federation, permanent storage, or a reader visit.

Unit tests use a substituted WebSocket relay and real Schnorr signatures. They
cover exact signed content, owner isolation, missing credentials, negative and
wrong-ID acknowledgements, timeout, abort, and resource bounds. These tests run
in PR CI; no live relay or shared-host scenario is run manually. Mastodon API publishing is documented in [Mastodon outbound](mastodon-outbound.md);
scheduling (#309) and nightly provider/federation acceptance remain outstanding. #455 stays
open and private reader cases remain unregistered.

A CI-only loopback TCP peer completes the WebSocket upgrade, then ignores all
frames, including CLOSE. The regression verifies that a timed-out publisher
actually reaches CLOSED; it is skipped during local unit runs.
