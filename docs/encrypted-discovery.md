# Discovery on a shared encrypted GunDB network with SociACL access control

Status: draft design. No code in this PR. Nothing here changes current behavior.

## Goal

All s3r.ch social data lives on one shared GunDB network. Every non-public item is encrypted. SociACL decides who may read each item. Peers connect and replicate across the whole network, so a reader needs an efficient way to find the items it is allowed to read, without the network learning who can read what.

Panopticon is optional. It is one login provider among several (`S3RCH_LOGIN_PROVIDERS`). Nothing in this design depends on it.

## What exists today

From FyberLabs/SociACL (`docs/verbs.md`, `docs/gun.md`, `docs/s3rch-check.d.ts`, `docs/s3rch-check.md`, `ARCHITECTURE.md`) and this repo (`docs/ARCHITECTURE.md`, `docs/identity.md`, `docs/s3rch-check.md`):

- **Authorization is `CHECK(action, object, accessor)`.** It answers yes or no for one named triple. It does not enumerate. `ARCHITECTURE.md` says "No Expand/ListUsers". On s3r.ch, `see` maps to Check `read` (`checkSee`, `checkSeeGrant`).
- **Grants on the s3r.ch surface** are the keep-operating `delegate` grant: `IdentitySeeGrant { claimId, accessor, from, until }`, applied with `applySeeGrant`, cancelled with `cancelSee` (owner `undelegate`, privilege-down immediate, object version bump).
- **Mesh grant rows** are `MeshSeeGrant` / `GunAclEdge` nodes at `s3rch/acl/<aclPrincipalKey(owner)>/<aclKey(object)>/<aclPrincipalKey(accessor)>` (helpers `aclSoul`, `grantSoul`, `aclKey`, `aclPrincipalKey`). Each peer runs `checkSee` on its local HAM-merged graph.
- **Hopcap is 1.** No friend-of-friend, no transitive or nested inheritance. Group and circle predicates (`same-group`, `named-circle`) exist in SociACL core but are **not** in the s3r.ch light contract yet.
- **Delivery inbox.** A live grant makes the holder put the object onto `s3rch/granted/<accessor>/{items|rooms|users}/<encodeKey(id)>` (Granted tab).
- **Keys.** After SIWE, each browser makes a SEA pair (`createSeaPair()` → `SEA.pair()`, P-256) and binds its `pub` to the wallet with a wallet signature (`docs/identity.md`). SociACL has no SEA integration and no key-wrapping primitive.
- **`DISCOVER` and `ELECT` are not discovery.** They are succession verbs: they need a pre-written will and run only after the owner's authn is gone. `docs/gun.md` excludes Elect, wills and devices from the s3r.ch Gun surface. This design does not use them.

### Known issue: the access graph is public today

`MeshSeeGrant` rows at `s3rch/acl/<owner>/<object>/<accessor>` and inbox rows at `s3rch/granted/<accessor>/…` are plaintext. Any peer or relay that replicates them learns, for every grant, who owns what, who may read it, and when it was granted. Inbox rows also carry the delivered object in clear. This design replaces both with encrypted or blinded rows. Until then, private grants should be treated as visible to the mesh.

## Design overview

Recipient-side discovery. Readers do not ask the network "what can I see". Each reader scans an inbox addressed to its own key, opens the entries it can decrypt, and verifies each with CHECK before use.

1. Owner encrypts the item with a fresh content key and puts the ciphertext on the shared graph.
2. For each reader (or group), owner wraps the content key to that reader's SEA `epub` and puts the wrapped key into the reader's blinded inbox.
3. Reader scans its inbox, unwraps keys, fetches ciphertext by pointer, decrypts.
4. Reader (and any peer serving it) still runs CHECK on the grant. A wrapped key is a capability to decrypt, not an authorization. CHECK stays the gate for anything with effects (writes, replies, re-sharing, server-side actions).

## Data model

### Items

```
s3rch/items/<itemId>          { v: 2, enc: 1, ct, iv, alg, owner, ver, ts? }
```

- `itemId` is random (128-bit), not derived from content or author, so the id does not link items.
- `ct` is the SEA/AES-GCM ciphertext of the existing `GunFeedNode` body (or room / claim node). `ver` matches the SociACL object version.
- `owner` is optional on the wire. Including it lets peers run CHECK without decrypting but leaks authorship. Default: omit for private items, store owner inside `ct`, and carry a signed owner proof in the grant (below).
- Public items stay `v: 1` plaintext on `s3rch/items`. Encryption is per item, not per network.

### Content keys and epochs

- One random 256-bit content key `K_item,e` per item per epoch `e`.
- The epoch bumps on every revoke (and on SociACL object version bump caused by privilege-down). New content after a revoke is encrypted under the new key.
- Old ciphertext stays under the old key unless the owner re-encrypts (see Revocation).

### Wrapped-key grant (inbox entry)

```
s3rch/inbox/<tag(readerEpub, slot)>/<entryId>
  { v: 1, eph, ct, iv }          // ECDH(eph, readerEpub) → AES-GCM
plaintext of ct:
  { item: <itemId>, e, key: K_item,e, owner, grantSoul?, from, until?, sig }
```

- Wrapping uses SEA's ECDH (`SEA.secret(readerEpub, ephemeralPair)`) with a fresh ephemeral pair per entry, then `SEA.encrypt`. The entry is unlinkable to the sender on the wire.
- `sig` is the owner's SEA signature over `(item, e, reader pub, from, until)`, so the reader can tell a real grant from junk and can present it to CHECK.
- `tag(readerEpub, slot)` is a blinded inbox address that only the reader (and the sender for that entry) can compute. Two options, decision open (see questions):
  - **(a) Static rendezvous:** reader publishes a signed `inboxPub` on its user node; tag = `H(ECDH(sender, inboxPub) || slot)`. Each sender-reader pair gets its own unlinkable lane; reader must check each known sender's lane.
  - **(b) Shared bucket:** tag = `H(readerEpub || day)` truncated to k bits, so many readers share a bucket. Reader scans the bucket and trial-decrypts. Larger k = less scanning, more linkability.
- This replaces the plaintext `s3rch/granted/<accessor>/…` delivery copy. The inbox holds keys and pointers, never plaintext content.

### Groups

The light contract has no group predicate yet, so v1 has two modes:

- **v1 (fan-out):** a "group" is a client-side list; the owner writes one wrapped-key entry per member. Correct under hopcap 1, cost O(members) per item.
- **v2 (group keys, needs SociACL `same-group` on the light surface):** each group has a group key pair per epoch `G_g,e`. Members receive `G_g,e` once in their inbox. Items for the group wrap `K_item` to `G_g,e.epub` once, stored at `s3rch/ginbox/<tag(G_g,e)>/…`. Cost O(1) per item, O(members) per membership change. Members are still hop 1 (direct members only; no nested groups).

## Discovery flow

```
reader                              shared graph / relays
  |  for each lane or bucket tag t:        |
  |---- get s3rch/inbox/<t>  (since cursor) -->
  |<--- entries (ciphertext only) ----------|
  |  trial-decrypt; verify owner sig        |
  |  CHECK(see, item, me) on merged graph   |
  |---- get s3rch/items/<itemId> ---------->|
  |<--- ct -------------------------------- |
  |  decrypt with K_item,e; index locally   |
```

- **Pagination:** inbox entries are keyed `<entryId> = <hlc>-<rand>` (hybrid logical clock prefix), so a reader reads by lexical range. Gun has no native range queries; use the `gun/lib/lex` `.get({'.': {'>': cursor}})` form, which relay peers can serve, and fall back to full-node fetch on peers that ignore it.
- **Incremental sync:** reader keeps a per-tag cursor in IndexedDB and subscribes (`.map().on`) to its active tags. Daily rotating tags bound how far back a scan goes; missed days are walked once at login.
- **Multi-device:** devices of one wallet share the SEA pair today (`docs/identity.md`). If per-device pairs are added, the owner wraps to each device epub, or the user publishes a wallet-level "device set" key. Open question.
- **Group discovery (v2):** read group inbox tags for each held `G_g,e`.
- **Authorization:** decryption is not authorization. `checkSee` / `checkSeeGrant` run on the reader's merged graph before an item is displayed as granted, and any relay doing work for the reader runs CHECK too. Because grant rows become encrypted (below), CHECK needs an input it can verify without the plaintext access graph; see the spec additions.

## Search

- **Opt-in public index.** Only public or explicitly opted-in fields (handle, tags, topic, public post text) go into a plaintext index (`s3rch/index/tag/<tag>/<itemId>`), extending the current tags-first Discover. Private items never enter it.
- **Local search after decryption.** Each client builds a local full-text index (IndexedDB, e.g. a MiniSearch-style inverted index) over items it has decrypted. This is the default for private content.
- **Group keyed tokens (optional).** For group search without a central index: members compute `T = HMAC(G_g,e.searchKey, normalize(term))` and publish `s3rch/gsearch/<groupTag>/<T>/<itemId>`. Members query by the same token. Non-members see opaque tokens. Leaks: term frequency and repetition within the group, and query patterns to the serving relay. Tokens are rotated with the group epoch. Not suitable for small groups or low-entropy terms (guessable by a former member who kept old keys).

## Privacy

| Observer | Learns today | Learns with this design |
| --- | --- | --- |
| Any peer | full grant graph, inbox plaintext | item ciphertext sizes and times; inbox entry counts per tag |
| Relay serving a reader | everything above | which tags a reader fetches, IP, timing |
| Former reader | old content | old content (cannot be clawed back); not new epochs |

- **Metadata leakage:** sizes (pad to buckets, e.g. 1/4/16/64 KiB), timing (owners may batch grant writes), fan-out (number of inbox entries written at once reveals audience size; batch or add dummy entries), and owner field (omit on private items).
- **Enumeration resistance:** random item ids; inbox tags are keyed, so nobody can list "all grants to wallet X" without the reader's secret or the sender's lane secret. Under option (b) buckets, an observer learns that a reader is one of the bucket's members.
- **Spam:** anyone can write to an inbox tag. Entries without a valid owner signature are dropped. Relays may rate-limit writes per tag. Proof-of-work or a SociACL `friend`/`in-network` precondition for writing to lane (a) is an option.

## Revocation and re-keying

SociACL's `cancelSee` / `undelegate` is immediate at CHECK. Under encryption it is not enough: the revoked reader still holds `K_item,e`.

- **Forward secrecy for new content:** on revoke, bump epoch, generate `K_item,e+1`, wrap to the remaining readers. Cost O(remaining readers) per affected item, or O(remaining members) once for a group key in v2.
- **Existing content:** cannot be revoked from someone who already decrypted. Optional lazy re-encryption: re-encrypt the item under `e+1` and tombstone the old ciphertext, so a revoked reader who did not cache it loses access. Cost O(item size).
- **Tombstones:** the old inbox entry is replaced with a tombstone in the same lane; HAM converges. Readers drop keys for tombstoned entries.
- **Batching:** owners revoking several readers at once do one rotation.
- Group v2 removals are the expensive case: one rotation per removal, O(members). Large groups may want tree-based group key agreement (e.g. MLS/TreeKEM, O(log n)), out of scope for v1.

## Performance on Gun

- **Fan-out:** v1 writes one inbox entry per reader per item. Fine for personal sharing (tens of readers). Groups beyond ~50 members should wait for v2 group keys.
- **Reads:** a reader touches only its own tags plus the items it can decrypt. No global scan. Trial-decryption cost under bucket option (b) is one ECDH per entry; keep buckets small.
- **Caching:** clients cache decrypted items and keys in IndexedDB (encrypted at rest with a key derived from the SEA pair). Relays cache ciphertext only.
- **Relay roles:** the `/gun` seed peer and any durable relay (`docs/durable-graph-and-turn.md`) store and serve ciphertext and inbox entries, may enforce write rate limits and size caps, and never hold content keys. Optional "mailbox relays" can be chosen per user to keep inbox tags off the general mesh. Relays must not mint `see` (existing rule).
- **Gun limits:** large nodes and wide maps replicate poorly; shard inbox tags by day and item ciphertext by chunk if over ~64 KiB.

## Federation

- **Identity:** a principal is its SEA pub bound to an account by a signed statement. Accounts are `provider:encoded-id` (see the provider-ID encoding in #106). Any login provider in `S3RCH_LOGIN_PROVIDERS` (Panopticon, Entra, another org's OIDC) produces a SEA binding the same way SIWE does today.
- **Cross-org sharing:** an owner wraps to any SEA pub, regardless of the reader's provider. CHECK accessor ids carry the provider prefix, so grants never collide across providers.
- **Org-run relays:** each org can run its own seed/mailbox relay; Gun peers replicate across them. Org policy (who may write to members' lanes) is enforced at that org's relay and by CHECK.
- **Org groups:** v2 groups may be owned by an org principal; membership still hop 1.

## Proposed SociACL spec additions

These are proposals for FyberLabs/SociACL. Nothing below exists today.

1. **Wrapped-key grant edge.** A `delegate`/see grant variant that carries `{ epoch, wrappedKey, recipientKeyId }`, signed by the owner. CHECK semantics unchanged; the edge additionally lets the recipient decrypt epoch `e`. Defines which key types are allowed (SEA P-256 epub to start).
2. **Private discovery.** A storage rule that grant rows need not be plaintext: an encrypted/blinded `MeshSeeGrant` form that the accessor (and optionally a designated verifier) can present to CHECK as a signed grant proof, so CHECK can be evaluated without publishing `s3rch/acl/<owner>/<object>/<accessor>` in clear. Includes the inbox tag derivation.
3. **Rotation on revoke.** Make `cancelSee` / `undelegate` on an encrypted object require an epoch bump and a re-wrap to remaining grantees; CHECK denies decryption-dependent actions for any grant on an older epoch.
4. **Group predicates on the light surface.** Add `same-group` (and possibly `named-circle`) to `s3rch-check.d.ts`, hop 1, with a group-key epoch tied to group membership changes.

## Open questions for Chris

1. Inbox addressing: per-sender lanes (a: more private, reader checks each known sender) or shared buckets (b: simpler, trial-decrypt, some linkability)?
2. Should private items carry `owner` in clear so peers can CHECK without decrypting, or keep authorship hidden?
3. Per-device SEA pairs, or one pair per wallet/account shared across devices as today?
4. On revoke, re-encrypt existing items (costly) or only protect new epochs?
5. Is group key search (keyed tokens) worth its leakage, or is local-only search enough for v1?
6. Who may write to someone's inbox: anyone (with spam filtering), only jointly stated `friend`/`in-network`, or only via an org relay?
7. Migration: encrypt existing Mine/granted content in place, or only new content? Plaintext `s3rch/granted` and `s3rch/acl` rows stay readable to anyone who already replicated them.
8. Do you want the SociACL additions above proposed upstream now, or after a prototype here?
