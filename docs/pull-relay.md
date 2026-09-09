# s3r.ch pull relay / extension

Internal contract. Not a public `/` or `/feed` essay.

Signed-in browsers still use same-origin `POST /api/ingest` as a CORS proxy. Direct browser-to-source still fails in a naked tab. This path is **additive**: a page handshake to an unpacked MV3 extension (`extensions/s3rch-pull`) or a `127.0.0.1` relay that fetches the **same documented source family** and hands rows into the existing Mine admit / share flow.

## Locks

- Allowlist only (Farcaster hub, ATProto AppView, documented RSS/Atom, ActivityPub actors, Nostr `nos.lol`, optional RSS3 GI). Not an arbitrary URL proxy.
- `/api/ingest` stays valid. Extension / relay miss falls back to it.
- Pull ≠ share ≠ grant ≠ outbound. Admit `GunFeedNode` `v: 1` onto Mine. Unknown Gun `v` fails closed.
- Azure App Service is still a seed peer / optional proxy, not a second datastore.
- No secrets on Gun or `NEXT_PUBLIC_*`.
- Do not turn off CORS on source hosts. This path exists because CORS is still there.

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
