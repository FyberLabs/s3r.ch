# Tenant object storage client

`lib/object-store.ts` defines the immutable opaque-byte operations used by media:
put exact content at its SHA-256 address, read and verify those bytes, or delete
that address. `lib/spanopticon-object-store-server.ts` implements those operations
for the s3r.ch tenant through the Spanopticon edge. Deployment supplies a fixed
HTTPS origin, tenant UUID and scoped service API key. Application callers cannot
select a provider URL, tenant or key per request.

The adapter refuses redirects, requests no caching, bounds objects to 64 MiB,
checks returned hashes and status codes, and cancels failed downloads. Calls have
a 120-second deadline and accept caller cancellation. Retry a failed upload with
the same bytes/address; a successful first write and an identical existing object
are both accepted. Errors never include provider response bodies or credentials.

The client belongs in server code; its service key must never reach browser code.
It is not an authorization boundary for end users. Before calling it, routes must
verify the current actor's access to the application object. Encrypt media in the
browser and keep the encryption key in private owner/grant material. A digest is
not a grant. This change adds no public upload route and enables no media player.

This immutable-byte interface is a building block for the broader deployment
storage interface. Mutable cache entries, conditional recovery writes, fixture
ownership and the future SociACL secret-store contract need separate operations;
this adapter does not claim to implement those contracts or an alternative vendor.
