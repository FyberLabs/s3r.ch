# s3r.ch pull relay / extension

Internal contract. Not a public `/` or `/feed` essay.

Signed-in browsers still use same-origin `POST /api/ingest` as a CORS proxy. Direct browser-to-source still fails in a naked tab. This path is **additive**: a page handshake to an unpacked MV3 extension (`extensions/s3rch-pull`) or a `127.0.0.1` relay that fetches the **same documented source family** and hands rows into the existing Mine admit / share flow.

## Decisions

- Allowlist only (Farcaster hub, ATProto AppView, documented RSS/Atom, ActivityPub actors, Nostr `nos.lol`, optional RSS3 GI). Not an arbitrary URL proxy.
- `/api/ingest` stays valid. Extension / relay miss falls back to it.
- Pull ≠ share ≠ grant ≠ outbound. Admit `GunFeedNode` `v: 1` onto Mine. Unknown Gun `v` fails closed.
- Azure App Service is still a seed peer / optional proxy, not a second datastore.
- No secrets on Gun or `NEXT_PUBLIC_*`.
- Do not turn off CORS on source hosts. This path exists because CORS is still there.

## Server feed destination policy

The server checks each literal URL, redirect and DNS answer against the same public-address rules. DNS answers must parse as the reported family, and all answers must pass before socket family selection. HTTP and HTTPS feeds may use public IPv4 or IPv6.

IPv4 excludes multicast, reserved and non-global special-purpose ranges, with the registered public anycast exceptions inside 192.0.0.0/24. Native IPv6 uses the global unicast allocation 2000::/3, excluding documentation space and non-global protocol assignments. The guard permits the more-specific globally reachable IETF assignments. IPv4-mapped and well-known NAT64 addresses inherit the embedded IPv4 policy. The server rejects local translation prefixes, deprecated compatible/translated forms, 6to4, Teredo and ISATAP.

When IANA changes the special-purpose registries or allocates new global unicast space, review the prefix tables in `lib/url-guard.ts` and update the boundary and exception tests in the same change. Treat blank or conditional global reachability in a special-purpose allocation conservatively. [IANA IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry/) · [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/)

## Server feed response limits

The server accepts up to 1,000,000 decoded bytes per ActivityPub, ATProto, Farcaster, RSS3 or RSS/Atom response, including custom RSS URLs and the Farcaster and RSS3 claim lookups. The JSON feeds request small pages and share the existing RSS budget. The reader counts bytes after HTTP decompression regardless of Content-Length. An oversized or failed upstream response is discarded before feed parsing.

Each server module instance admits up to 20 concurrent HTTP feed pulls. The configured seed can start 18 at once. Additional pulls fail immediately through the existing source error path. Nostr uses a separate WebSocket transport.

## Channel

`channel: "s3rch-pull"`, `v: 1`. Unknown `v` / channel / `via` is ignored or denied.

| type | who | body |
| --- | --- | --- |
| `hello` | page | `{ channel, type, v }` |
| `ready` | extension or relay | `{ channel, type, v, via: "extension" \| "localhost" }` |
| `pull` | page | `{ channel, type, v, id, body }` where `body` is one of `rssUrl` / `rss3Account` / `allowedSource` |
| `result` | extension or relay | `{ channel, type, v, id, items?, fetches?, sourcesOk?, sourcesTried?, error? }` |
| `denied` | extension or relay | `{ channel, type, v, id?, error }` |

`fetches` are `{ url, status, body }` from allowlisted hosts only. The page assembles them with the same normalizers as the seeder. `items` are already `FeedItem` rows; unknown Gun `v` is dropped.

## Local relay

`http://127.0.0.1:17373/s3rch-pull/hello` and `POST /s3rch-pull/pull`. Bound to loopback. CORS only for `http://localhost` / `http://127.0.0.1` page origins. `https://s3r.ch` cannot use this (mixed content) — load the extension.

```bash
npx tsx scripts/s3rch-pull-relay.ts
```

## Extension

Unpacked MV3 in `extensions/s3rch-pull`. `host_permissions` are the documented fetch hosts. Content script matches `s3r.ch` and local http pages. Same-origin `postMessage` only.
