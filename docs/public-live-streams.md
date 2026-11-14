# Public live streams

`/live` lists Nostr NIP-53 kind-30311 events from the site's fixed
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
