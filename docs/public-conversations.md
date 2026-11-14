# Public conversation context

Expanding a reply first requires its source and ID to be present in the current
public snapshot. Mine, Granted and private-room objects are not lookup inputs.
The existing FIFO queue permits four active requests and 32 waiters, with a
five-second admission wait. The response remains capped at 512 KiB.

For Bluesky, one unauthenticated AppView `app.bsky.feed.getPostThread` request
asks for eight ancestors and one reply level. The endpoint comes from the site's
AppView configuration, never from a query parameter or post URL. Existing public
fetch controls bound DNS/address access, timeout and response bytes. Only matching
post URIs and connected parent/direct-reply records are projected. Blocked,
not-found, malformed and unrelated nodes are ignored. The output has at most
eight ancestors, the anchor, and 16 direct replies. Other sources currently keep
the cached-conversation fallback; their provider fetch adapters remain #409 work.

Successful provider responses have a 60-second in-process cache; failures have a
15-second negative cache. The cache holds at most 64 keys with four concurrent
provider operations and coalesces identical requests. It is transient response
caching, not a durable product store or the hosted Spanopticon cache cutover.
A missing/deleted/private/rate-limited parent leaves the reply and its unavailable
placeholder visible. No provider credential or visitor login is sent to AppView.

Fetched media uses the existing public media proxy. The conversation response
carries HMAC tickets for specific normalized media roots, bound to the hash of the
public anchor's source and ID. Tickets last at most one hour; every media request
still requires that anchor in the current public snapshot. HLS child requests
carry both the existing signed child binding and the context ticket. Changing the
root, type, expiry, signature or anchor fails closed. Removing the public anchor
prevents further ticketed requests; it cannot recall bytes already downloaded.
Tickets are public-fetch admission, not SociACL grants, private wraps or storage
credentials. External media is fetched anonymously and must remain reachable
through the public-address guard. Without the existing media-signing secret,
conversation reads retain the cached-only behavior.

CI covers traversal and count limits, source failures, cache expiry/overload,
forged media roots, expiry, child URLs and anchor removal. The CI-only browser
fixture runs the actual provider adapter, conversation component and media
admission path to check parent/reply order, a ticketed image, a blocked-parent
placeholder and denial after anchor removal. No shared TEST data is involved.

Primary API schema:
[Bluesky getPostThread](https://github.com/bluesky-social/atproto/blob/main/packages/api/lexicons/app/bsky/feed/getPostThread.json).
