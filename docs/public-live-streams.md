# Public live streams

`/live` lists Bluesky live statuses and Nostr NIP-53 kind-30311 events from the site's fixed
`PUBLIC_NOSTR_PUBKEYS` set. This is not a visitor's personal follow list.
`GET /api/live` accepts no caller-selected relay, author or room. Room streams,
private-room grants, live ingest and other providers remain separate work under
#410, #306 and #153. No private graph or room state enters this directory.

Before display, the server checks the NIP-01 event ID and BIP-340 Schnorr
signature against the publishing key. It does not claim that people named in
participant tags are verified hosts. The UI names the publisher and labels
counts as publisher-reported participants, not independently measured viewers.

The newest authenticated event for each publisher and `d` address wins;
equal timestamps use the lowest event ID. Ended, planned and otherwise
non-displayable replacements suppress older live events. Events expire one
hour after their signed creation time. A declared end time can expire them
earlier. Future starts are hidden. The browser removes expired entries and
unmounts their players without waiting for another successful source fetch.

One shared in-process poll runs at most once a minute. It uses the existing
bounded relay transport with a limit of 20 events per followed author.
Malformed, unsigned, foreign-author and oversized responses cannot populate the
directory. Failed pulls preserve earlier entries only until their expiry.
At most 1,600 replacement markers are retained and 100 live entries are returned.
At capacity, new addresses are refused rather than evicting unexpired ended
markers. A monotonic timestamp floor also prevents an older live version of a
refused address from being admitted later when capacity becomes available.
This state is process-local: it is not durable trusted history across restart
or a guarantee that a relay has returned the newest signed event.

Images and playback use `/api/feed/media`, including its public-address checks,
byte/request limits and signed HLS child URLs. Live-media admission is independent
of feed-snapshot availability. A missing signing configuration still fails closed.
Neither the browser nor a query parameter can introduce an unlisted media root.
No storage credentials, private wraps or provider tokens are returned.

CI runs signed-event unit cases for invalid signatures, replacement, expiry,
failed pulls and capacity replays, plus media-source admission cases. The
CI-only browser fixture exercises selection, proxied media URLs, expiry and ended
refresh without contacting external providers. These fixtures do not establish
real provider availability or room/private-stream acceptance.

Protocol references:
- [NIP-01 event signing and replacement](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-53 live streaming](https://github.com/nostr-protocol/nips/blob/master/53.md)

The same bounded NIP-01 verifier also authenticates ordinary public kind-1 notes
before a relay window enters the feed cache. A forged or unsigned note fails the
whole source window, preserving the previous successful window rather than
publishing a partial prefix or treating the failure as an empty success. Kind-1
notes do not inherit the live directory's one-hour expiry. The shared verifier
uses WebCrypto hashing and is covered by a CI-only real-browser signature fixture.

## Bluesky live status

The fixed author entries in `PUBLIC_ATPROTO_SOURCES` are queried through the
configured `ATPROTO_APPVIEW_BASE` public AppView `app.bsky.actor.getProfile`.
Feed generators do not establish followed authors. Visitors cannot supply an
actor or endpoint. The existing public fetcher bounds time, response bytes and
concurrency and checks public addresses through redirects.

The response must match the configured handle or DID. This trusts the configured
AppView over HTTPS; it does not independently verify an AT repository signature.
Only active `app.bsky.actor.status#live` status with a valid creation/expiry time
and an external embed is displayed. Disabled and labelled statuses are hidden.
The stream opens on its public HTTPS streaming site with no referrer; the embed
URL is not assumed to be a media file or admitted to the media proxy. No thumbnail
or participant count is fabricated from the status.

A successful missing, inactive or non-displayable status removes the previous
entry. Failed pulls retain it only until the earlier of its declared expiry or
five minutes after its last successful observation. One shared poll runs at most
once per minute, with at most 16 configured authors. This is transient public
cache state, not new durable storage. Unit contracts cover admission, ended and
expired status, concurrent polls and failed pulls. The existing CI-only browser
fixture covers the external link and its removal on expiry without external
network requests. These are isolated fixtures, not shared TEST qualification.

Protocol: [Bluesky statusView](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/defs.json).
Room/private-stream coverage remains open under #410/#306.


## ActivityPub live video

The existing fixed `PUBLIC_ACTIVITYPUB_ACTORS` list also supplies discovery for
PeerTube-compatible ActivityPub `Video` objects. This does not add a new followed
account or accept visitor-selected URLs. Other ActivityPub live extensions are
not inferred from ordinary posts or video attachments.

Each poll fetches the actor, its same-origin outbox and at most one first page.
It scans at most 20 activities and refetches at most four distinct same-origin
objects named by that actor's Create, Update or Announce activities. Embedded
video metadata is discovery only. Canonical retrieval uses the existing bounded
public fetcher and rejects redirects to another authority. Actor identity,
video identity, attribution, explicit public audience and nonsensitive status
must match. Only `isLiveBroadcast: true` and published state `1` are displayed;
waiting, ended, replay and unsupported states are hidden.

This trusts the origin over HTTPS, not an independently verified ActivityPub
signature. It is a bounded discovery window, not a complete subscription history.
A successful empty/non-live window removes previous entries. A failed poll retains
only the prior observations until their five-minute expiry; it never renews them.
Polling coalesces concurrent requests and runs at most once per minute, with four
configured actors maximum. No new request starts after the per-actor 30-second
discovery budget; each active request retains the existing fetch timeout/byte cap.

Entries open the origin's external player with no referrer. No thumbnail, direct
media stream or cumulative view count is used. The UI says “Live at last check”:
a permanent live video's publication date does not establish the current stream
start. Source responses and polling are substituted in mock unit tests; the
existing CI-only browser fixture substitutes directory responses and verifies
external links, labels and expiry. Neither proves provider availability or
private-room permission enforcement.

Protocol references: [PeerTube ActivityPub Video and activities](https://docs.joinpeertube.org/api/activitypub)
and [published, waiting and ended state values](https://docs.joinpeertube.org/api-rest-reference/api/my-subscriptions.html).
