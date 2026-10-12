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
s3rch/items/<itemId>          { v: 2, enc: 1, ct, iv, alg, ver, ts? }   // no owner field
s3rch/items/<itemId>/r/<rev>  { v: 2, enc: 1, ct, iv, alg, ver }       // later revisions
```

- `itemId` is random (128-bit), not derived from content or author, so the id does not link items.
- `ct` is the SEA/AES-GCM ciphertext of the existing `GunFeedNode` body (or room / claim node). `ver` matches the SociACL object version.
- Authorship is hidden by default: `owner` is not on the wire for private items. It sits inside `ct` and inside each wrapped-key entry. See *Author fast path* and *CHECK without a visible owner*.
- Public items stay `v: 1` plaintext on `s3rch/items`. Encryption is per item, not per network.
- **Owner authentication of the ciphertext.** Every grantee of a shared item knows `K_item,e`, so AES-GCM only proves the writer held the content key, not that the owner wrote the content. Inside `ct`, the body therefore carries `osig`, the owner's SEA signature over `(itemId, e, rev, H(unsignedBody))`, where `unsignedBody` is the canonical serialization of the body with the `osig` field omitted, and the `iv`/`ct` pair is also covered by the owner-signed revision manifest (below), whose `envDigest` binds the whole AEAD envelope. Readers reject any item whose envelope digest (covering `iv` as well as `ct`) does not match a manifest signed by the owner's account key, so a grantee cannot write a replacement node, forged `owner` included, at the same path. Relays can additionally require that writes to `s3rch/items/<itemId>` be immutable once set (new revisions go to `s3rch/items/<itemId>/r/<rev>`), so a dominating HAM update cannot displace a valid revision.

### Content keys and epochs

- One random 256-bit content key `K_item,e` per item per epoch `e`.
- The epoch bumps on every revoke (and on SociACL object version bump caused by privilege-down). New content after a revoke is encrypted under the new key.
- Old ciphertext stays under the old key unless the owner re-encrypts (see Revocation).
- **Serializing epochs across devices.** Every enrolled device holds the account key, so two devices could each pick a different random key for `e+1`. Each rotation is therefore an owner-signed revision manifest `{ itemId, e, rev, parent, keyId = H(K_item,e), envDigest = H(itemId || e || rev || alg || iv || ct) }` with a unique `rev` id and a `parent` pointer to the manifest it supersedes. Wraps name the `keyId` they carry. If two manifests claim the same `e` with the same parent, the winner is chosen deterministically (lowest `H(manifest)`). Where an owner uses a status authority (see *CHECK without a visible owner*), the authority's signed head is the tie-breaker instead, and clients follow it, and the losing device re-wraps its content under the winner's key once it sees the conflict. A device must have synced the latest manifest for an item before it writes new content; content that names a superseded manifest (for example from a device that was offline during a rotation) is rejected by readers and must be re-issued under the current epoch.

### Wrapped-key grant (inbox entry)

```
s3rch/inbox/<tag(readerEpub, slot)>/<entryId>
  { v: 1, eph, ct, iv, wsig }    // ECDH(eph, readerEpub) → AES-GCM
plaintext of ct:
  { item: <itemId>, e, key: K_item,e, owner, grantSoul?, from, until?, sig }
```

- **Writer-authenticated, immutable entries.** The per-pair tag hides the lane but is not a write ACL, and the relay serving the reader learns tags and entry ids. Each entry therefore carries `wsig`, a signature over `(tag, entryId, H(eph || ct || iv))` by a per-lane writer key `W = derive(ECDH(senderPair, inboxPub), "writer")`. The writer pub is never published next to the lane or on the reader's account node, since that would link the lane to the reader. The reader gives it only to the relays it chooses, over a private authenticated subscription, and those relays reject entries without a valid `wsig`. Entries are write-once: relays refuse any update to an existing `entryId`, and readers keep the first valid value they see and ignore later conflicting ones, so a dominating HAM update cannot replace a legitimate entry.
- Wrapping uses SEA's ECDH (`SEA.secret(readerEpub, ephemeralPair)`) with a fresh ephemeral pair per entry, then `SEA.encrypt`. The entry is unlinkable to the sender on the wire.
- `sig` is the owner's SEA signature over the grant tuple `(item, e, rev, keyId, reader pub, from, until, object version)`; this is the exact tuple the grant proof below refers to, so the reader can tell a real grant from junk and can present it to CHECK.
- `tag` is a private per-pair lane: each reader publishes a signed `inboxPub` on its account node, and `tag = H(ECDH(senderPair, inboxPub) || slot)`, where `slot` is a day or sequence number. Only the sender and the reader can derive it. Each sender-reader pair gets its own unlinkable lane, and the reader polls only the lanes of senders it knows (plus a first-contact lane, below). Shared buckets with trial decryption are not used: scanning shared buckets is inefficient.
- **First contact:** a sender the reader has never seen writes a signed introduction, encrypted to `inboxPub` and carrying the sender's signing `pub` and encryption `epub` (SEA keeps these as separate fields, see `SeaPair` in `lib/identity/sea.ts`), with the signature covering both. The reader verifies the signature and the sender's account binding, then derives the per-pair lane from `ECDH(inboxPair, sender epub)`. The introduction goes to a first-contact lane derived from the reader alone, `H(inboxPub || "intro" || day)`. That lane is subject to the reader's inbox write policy (see Privacy). After the first intro, traffic moves to the per-pair lane.
- **Time bounds in the key schedule.** `from` and `until` are not left to the recipient's CHECK alone. The owner delivers the wrap only once `from` is reached, and when `until` passes the owner rotates the item to a new epoch going forward without the expired reader, the same cheap rotation as a revoke (no re-encryption of existing items). Content written before `until` stays readable to that reader, as with any former reader.
- This replaces the plaintext `s3rch/granted/<accessor>/…` delivery copy. The inbox holds keys and pointers, never plaintext content.

### Author fast path

The author must find and unwrap their own items cheaply without anyone else learning authorship. For each item, the author writes a self-wrapped entry into their own author lane:

```
s3rch/inbox/<H(accountKeyDerivedSecret || "author" || slot)>/<entryId>   { eph, ct, iv, wsig }
```

Author-lane entries use the same write-once envelope as grant entries: `wsig` is made with a writer key derived from the account's author-lane secret, so relays and readers reject replacements. The lane tag is derived from a secret only the account holds, so to others it looks like any other inbox lane. The entry wraps `K_item,e` to the account's own epub and also holds the item id and epoch. The author lists their items by scanning one lane, with no trial decryption. On rotation (epoch bump), the author re-writes the self-wrapped entry.

### CHECK without a visible owner

Today `checkSee` runs on a peer's merged graph and reads the plaintext `MeshSeeGrant` at `s3rch/acl/<owner>/<object>/<accessor>`. With hidden owners, that row cannot be public. Authorization moves to the reader side:

- The wrapped-key entry carries a **grant proof**: the entry's `sig` over the grant tuple `(itemId, e, rev, keyId, accessor pub, from, until, object version)`, plus the owner's account-key binding (pub signed by the login provider or wallet).
- The reader decrypts the entry and runs CHECK locally against that proof, which holds the same facts as today's `IdentitySeeGrant`. It's the reader's own client checking its own access.
- When a peer or relay must authorize an action (a reply, a write into a group, a server-side action), the reader presents the grant proof to that verifier over a direct channel. The verifier learns the owner for that one item only. The mesh at large never sees it.
- **Proof of possession.** The grant proof names the accessor but does not show that the presenter controls that accessor's key, so a leaked proof could be replayed. The verifier sends a fresh nonce, and the presenter returns the proof plus a signature over `(nonce, verifier id, H(proof))` made with the accessor's SEA private key. The verifier checks that signature against the accessor pub named in the proof and checks that pub's account binding.
- **Revocation and freshness.** The owner publishes a revocation token `H(itemId || epoch || accessor || nonce)` under the author lane or an item-keyed revocation lane. Absence of a token in an eventually replicated graph does not prove a grant is live, because a stale or partitioned verifier may not have received it yet. For server-side actions, the verifier therefore needs positive freshness: a status statement `{ itemId, e, rev, issuedAt }` that names the current revision manifest. To keep stale devices from vouching for a revoked epoch, status issuance is serialized with rotation: statements are signed either by an online status authority the owner designates, which accepts a manifest only if its `parent` is the head it already holds and then signs statements only for that head, or by an owner device after it has confirmed the current head with that authority. The authority serializes sibling manifests itself: it accepts the first valid child of its head, signs that as the new head, and owner devices that lose re-issue under it, so clients and the authority agree on one head. Verifiers require the grant proof's `rev` and `keyId` to equal the head named in the statement, and the statement must be no older than a short window (for example 5 minutes). Without a fresh statement the verifier refuses the action. Revocation is then immediate up to that window for verifiers that require freshness. Reader-side display, which works offline, only stops at the next epoch the reader learns about; that weaker guarantee is accepted for offline reads.
- This needs the SociACL "private discovery" addition (spec section below). Current SociACL CHECK reads a plaintext graph.

### Groups

The light contract has no group predicate yet, so v1 has two modes:

- **v1 (fan-out):** a "group" is a client-side list; the owner writes one wrapped-key entry per member. Correct under hopcap 1, cost O(members) per item.
- **v2 (group keys, needs SociACL `same-group` on the light surface):** each group has a group key pair per epoch `G_g,e`. Members receive `G_g,e` once in their inbox. Items for the group wrap `K_item` to `G_g,e.epub` once, stored at `s3rch/ginbox/<tag(G_g,e)>/…`. Cost O(1) per item, O(members) per membership change. Members are still hop 1 (direct members only; no nested groups).

## Discovery flow

```
reader                              shared graph / relays
  |  for each known lane tag t:            |
  |---- get s3rch/inbox/<t>  (since cursor) -->
  |<--- entries (ciphertext only) ----------|
  |  unwrap; verify grant proof             |
  |  CHECK(see, item, me) on grant proof    |
  |---- get s3rch/items/<itemId>/r/<rev> -->|   (rev from verified grant/status)
  |<--- ct -------------------------------- |
  |  decrypt with K_item,e; index locally   |
```

- **Pagination:** inbox entries are keyed `<entryId> = <hlc>-<rand>` (hybrid logical clock prefix), so a reader reads by lexical range. Gun has no native range queries; use the `gun/lib/lex` `.get({'.': {'>': cursor}})` form, which relay peers can serve, and fall back to full-node fetch on peers that ignore it.
- **Incremental sync:** HLC keys are only monotonic per device, and one account can write from several devices or restore a stale clock, so the greatest key seen is not a lossless cursor. Each entry also carries a per-device id and sequence number inside `ct`, and the reader keeps a per-tag, per-device high-water mark. On login and on reconnect the reader rescans each daily shard it has not marked complete and deduplicates by `entryId`; a shard is not closed by an empty rescan. The reader keeps rescanning each daily shard for a retention window (for example 30 days), and a shard can close early only on close markers from every writer device of the sender account: each enrolled device signs its own marker `{ lane, day, deviceId, lastSeq }` with its device key, and the reader closes the shard once it holds a marker from every device in the sender's current device records and every listed sequence. A missing marker from any device keeps the shard open for the full window. The lex `> cursor` query is an optimization for live updates, never the only path. The reader also subscribes (`.map().on`) to its active tags.
- **Multi-device:** one SEA key pair per account. Senders wrap only to the account epub, never per device. See *Device enrollment and revocation*.
- **Group discovery (v2):** read group inbox tags for each held `G_g,e`.
- **Authorization:** decryption is not authorization. `checkSee` / `checkSeeGrant` run on the reader's merged graph before an item is displayed as granted, and any relay doing work for the reader runs CHECK too. Because grant rows become encrypted (below), CHECK needs an input it can verify without the plaintext access graph; see the spec additions.

## Device enrollment and revocation

Each account has one SEA key pair. Devices get it through enrollment from a device that's already enrolled:

1. The new device creates a temporary ECDH pair and shows a pairing code (a QR code holding its temporary pub plus a short random secret).
2. The existing device scans the code, and the user confirms on both screens that a short authentication string matches.
3. The existing device encrypts the account key pair to the new device's temporary pub and binds it to the pairing secret, then sends it over a direct channel or a one-time encrypted inbox entry that expires quickly.
4. The same transfer carries the account's inbox pair (the private half of `inboxPub`), the author-lane secret and the lane state (known senders, writer keys, per-device high-water marks), so the new device can derive every lane and open introductions. The new device stores these and the account pair in IndexedDB, encrypted at rest with a non-exportable WebCrypto key, and signs a device record (`deviceId`, `devicePub`, enrolled time) with the account key. Records live on the account node.
5. If the user still has a login provider session or wallet (SIWE), enrollment can also require a fresh login on the new device as a second factor.

**Revoking a device.** Because every device holds the same account key, revoking a device means rotating the account key:

- Generate a new account pair on a trusted device, sign a succession record with the old key (`old pub → new pub`, revoked `deviceId`), and re-bind the new pub to the account through the login provider or wallet.
- Re-enroll the remaining devices with the new key, using the enrollment step above.
- The account's current key is defined by a monotonic binding: the login provider or wallet signs `{ account, keyPub, seq }`, and readers and verifiers keep the highest `seq` they have seen and reject manifests, grant proofs and status statements signed by an older key, whatever succession records the old key signs. A competing successor signed only by the old key is ignored.
- Re-key before abandoning the old key: a trusted device, still holding the old pair, re-wraps the account's owned content keys and author-lane entries to the new account epub, re-signs with the new key the current revision manifest of every item the account owns, reissues its outbound grant proofs (and status statements) to existing grantees under the new key, and the succession record lets grant owners reissue active wraps and grant proofs to the new pub. Readers reject old-key signatures only after the new binding is in place, so the hand-over publishes new-key manifests and proofs before the old binding is superseded. Re-enrolled devices receive the old pair only for the duration of this hand-over, and it is deleted once the re-wrap completes.
- Publish a new `inboxPub`. Senders move to new lanes, and lanes under the old key are drained, then abandoned.
- Content keys the revoked device already held stay exposed, just like a revoked reader. The user gets the same prompt as for reader revocation: rotate going forward only, or re-encrypt existing items.

## Search

Search follows a three-tier index model.

1. **One public index, public content only.** Public or explicitly published fields (handle, tags, topic, public post text) go into one plaintext index (`s3rch/index/tag/<tag>/<itemId>`), extending the current tags-first Discover. Any peer can read and serve it. Private items never enter it.
2. **One index per private group, readable only by members.** Each group keeps its own index, maintained by group members or the group's relay. Index entries are encrypted under the group's v2 group key for the current epoch (`G_g,e`), so non-members and relays see only ciphertext. Lookups could use keyed tokens (**needs discussion; look for a better approach**), `T = HMAC(G_g,e.searchKey, normalize(term))` at `s3rch/gsearch/<groupTag>/<T>/<itemId>`, so a member queries by token without decrypting the whole index. The index is rebuilt or re-keyed when the group epoch bumps (membership change), so a removed member cannot read entries written after removal. Leaks to the serving relay: token frequency and query patterns within the group. Small groups or guessable terms can make tokens linkable; members may fall back to fetching and decrypting the whole index.
3. **Individuals: push/pull delivery, then a local index.** For one-to-one or small personal shares, owners push wrapped keys to readers' inboxes and readers pull them (see Discovery flow). These sets are much smaller, so each device indexes what it has decrypted locally (IndexedDB, e.g. a MiniSearch-style inverted index, encrypted at rest). No shared index exists for this tier.

## Privacy

| Observer | Learns today | Learns with this design |
| --- | --- | --- |
| Any peer | full grant graph, inbox plaintext | item ciphertext sizes and times; inbox entry counts per tag |
| Relay serving a reader | everything above | which tags a reader fetches, IP, timing |
| Former reader | old content | old content (cannot be clawed back); not new epochs |

- **Metadata leakage:** sizes (pad to buckets, e.g. 1/4/16/64 KiB), timing (owners may batch grant writes), fan-out (number of inbox entries written at once reveals audience size; batch or add dummy entries), and owner field (omit on private items).
- **Enumeration resistance:** random item ids; inbox tags are keyed, so nobody can list "all grants to wallet X" without the reader's secret or the sender's lane secret.
- **Inbox write policy:** the user decides. The default is **public**: anyone can write to the first-contact lane. Self-signatures alone don't stop spam, since anyone can make new SEA pairs, so admission to a public first-contact lane requires a mandatory resource proof (proof-of-work sized by the reader's relay, or an account binding from a login provider the reader accepts). Relays apply quotas per sender key and per source, separate from the reader's capacity: one sender exhausting its own quota cannot block introductions from others, and the lane keeps a reserved share for senders with an account binding. Users can restrict intros to jointly stated `friend` or `in-network` principals, or to their org relay. Per-pair lanes accept only the paired sender anyway.

## Revocation and re-keying

SociACL's `cancelSee` / `undelegate` is immediate at CHECK. Under encryption it is not enough: the revoked reader still holds `K_item,e`.

The user decides on each revoke. The UI asks: **rotate going forward only** (new epoch for future content, cheap) or **re-encrypt existing items** (new epoch plus re-encryption of the affected items, costly). It shows the item count and an estimated cost for the second choice, and states that re-encryption is best-effort: copies already on other peers stay readable to anyone who held the old key.

- **Forward secrecy for new content:** on revoke, bump epoch, generate `K_item,e+1`, wrap to the remaining readers. Cost O(remaining readers) per affected item, or O(remaining members) once for a group key in v2.
- **Existing content:** cannot be revoked from someone who already decrypted. Optional re-encryption: re-encrypt the item under `e+1` and tombstone the old ciphertext. This is best-effort cleanup: on a shared, eventually replicated mesh any peer may keep the old revision, and a revoked reader holding `K_item,e` can still fetch and decrypt it there. It only removes access through relays that honor tombstones and enforce deletion. Cost O(item size).
- **Tombstones:** entries are write-once, so a tombstone is a new entry in the same lane, under a new `entryId` and with its own `wsig`, that references the original `entryId`. Readers drop keys for tombstoned entries.
- **Batching:** owners revoking several readers at once do one rotation.
- Group v2 removals are the expensive case: one rotation per removal, O(members). Large groups may want tree-based group key agreement (e.g. MLS/TreeKEM, O(log n)), out of scope for v1.

## Performance on Gun

- **Fan-out:** v1 writes one inbox entry per reader per item. Fine for personal sharing (tens of readers). Groups beyond ~50 members should wait for v2 group keys.
- **Reads:** a reader touches only its own tags plus the items it can decrypt. No global scan. Each entry costs one ECDH to unwrap; there is no trial decryption of other readers' entries.
- **Caching:** clients cache decrypted items and keys in IndexedDB (encrypted at rest with a key derived from the SEA pair). Relays cache ciphertext only.
- **Relay roles:** the `/gun` seed peer and any durable relay (`docs/durable-graph-and-turn.md`) store and serve ciphertext and inbox entries, may enforce write rate limits and size caps, and never hold content keys. Optional "mailbox relays" can be chosen per user to keep inbox tags off the general mesh. Relays must not mint `see` (existing rule).
- **Gun limits:** large nodes and wide maps replicate poorly; shard inbox tags by day and item ciphertext by chunk if over ~64 KiB.

## Federation

- **Identity:** a principal is its SEA pub bound to an account by a signed statement. Accounts are `provider:encoded-id` (see the provider-ID encoding in #106). Any login provider in `S3RCH_LOGIN_PROVIDERS` (Panopticon, Entra, another org's OIDC) produces a SEA binding the same way SIWE does today.
- **Cross-org sharing:** an owner wraps to any SEA pub, regardless of the reader's provider. CHECK accessor ids carry the provider prefix, so grants never collide across providers.
- **Org-run relays:** each org can run its own seed/mailbox relay; Gun peers replicate across them. Org policy (who may write to members' lanes) is enforced at that org's relay and by CHECK.
- **Org groups:** v2 groups may be owned by an org principal; membership still hop 1.

## Proposed SociACL spec additions

These are proposals for FyberLabs/SociACL. The matching spec change is [FyberLabs/SociACL#20](https://github.com/FyberLabs/SociACL/pull/20) (wrapped-key grants); none of it is implemented in s3r.ch yet. Item 2 also covers the reader-side grant proof and revocation tokens described under *CHECK without a visible owner*.

1. **Wrapped-key grant edge.** A `delegate`/see grant variant that carries `{ epoch, wrappedKey, recipientKeyId }`, signed by the owner. CHECK semantics unchanged; the edge additionally lets the recipient decrypt epoch `e`. Defines which key types are allowed (SEA P-256 epub to start).
2. **Private discovery.** A storage rule that grant rows need not be plaintext: an encrypted/blinded `MeshSeeGrant` form that the accessor (and optionally a designated verifier) can present to CHECK as a signed grant proof, so CHECK can be evaluated without publishing `s3rch/acl/<owner>/<object>/<accessor>` in clear. Includes the inbox tag derivation.
3. **Rotation on revoke.** Make `cancelSee` / `undelegate` on an encrypted object require an epoch bump and a re-wrap to remaining grantees; CHECK denies decryption-dependent actions for any grant on an older epoch.
4. **Group predicates on the light surface.** Add `same-group` (and possibly `named-circle`) to `s3rch-check.d.ts`, hop 1, with a group-key epoch tied to group membership changes.

## Migration

When a new protocol version is applied, existing data is encrypted in place, driven by each owner: the owner's client re-encrypts the items it owns (Mine), picks the content key, writes wrapped-key entries with fresh grant proofs for every current grantee, writes author-lane entries, and then tombstones its plaintext `s3rch/granted` and `s3rch/acl` rows and any plaintext `s3rch/items` row of a non-public item. Public items stay plaintext `v: 1` rows on `s3rch/items` until the owner changes their visibility. Grantees never re-encrypt objects in their Granted tab, because they cannot choose the key, enumerate other grantees or sign proofs; they keep reading the old representation until the owner's wrapped-key entry arrives, then drop their plaintext copy. Plaintext that peers already copied stays exposed. Tombstones can't recall it.

## Decisions and open questions

1. **Resolved:** inbox addressing uses a private per-pair lane that only the sender and reader can derive. Shared-bucket trial decryption is dropped as inefficient.
2. **Resolved:** authorship is hidden by default. The author fast path is a self-wrapped key in an author-only lane, and CHECK moves to reader-presented grant proofs.
3. **Resolved:** one SEA key pair per account. Devices get it through enrollment from an existing device, and revoking a device rotates the account key.
4. **Resolved:** on each revoke the user chooses, through a UI prompt, between rotating going forward and re-encrypting existing items.
5. **Open: group search. Needs discussion; look for a better approach than keyed tokens.** Candidates:
   - Members fetch the group's encrypted index and search it locally (simple, no query leakage, bandwidth grows with the group).
   - The group relay runs search inside a trusted execution environment (strong usability, adds trust in hardware).
   - Encrypted Bloom filters or sharded indexes per epoch, with members fetching only matching shards (less leakage than tokens, some false positives).
   - Private information retrieval (PIR) against the relay's index (hides queries, expensive).
   - Structured or searchable encryption with volume hiding (research grade).
6. **Resolved:** inbox write policy is the user's choice, defaulting to public with spam filtering.
7. **Resolved:** a new protocol version encrypts existing data in place. Plaintext peers already copied stays exposed.
8. **Resolved:** the SociACL additions are proposed upstream in [FyberLabs/SociACL#20](https://github.com/FyberLabs/SociACL/pull/20).
