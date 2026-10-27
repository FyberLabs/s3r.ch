# Discovery on a shared encrypted GunDB network with SociACL access control

Status: draft design. No code in this change. Nothing here changes current behavior. The five gaps in [#113](https://github.com/FyberLabs/s3r.ch/issues/113) are specified below. The copied light contract in [s3rch-check.d.ts](s3rch-check.d.ts) does not yet carry these types. The SociACL deltas are re-typed under *Proposed SociACL spec additions* and are not imported from the SociACL crate.

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
s3rch/items/<itemId>          { v: 2, enc: 1, first }                    // write-once locator, no ciphertext
s3rch/items/<itemId>/r/<rev>  { v: 2, enc: 1, ct, iv, alg, ver }         // every envelope, including the first
s3rch/items/<itemId>/m/<rev>  { v: 1, manifest, msig }                   // signed revision manifest
```

- `itemId` is random (128-bit), not derived from content or author, so the id does not link items.
- **First revision path.** The first envelope is stored at `s3rch/items/<itemId>/r/<rev>`, the same path as every later envelope. `rev` is that revision's manifest id, including for the first revision. Readers always fetch that path. They do not read ciphertext from the root, and an empty revision node is an empty read: there is no fallback that treats the root as the body. The root `s3rch/items/<itemId>` is a write-once locator `{ v: 2, enc: 1, first }` whose `first` equals that first `rev`. It has no `ct`, no `iv`, and no owner field. Relays reject a root write that carries ciphertext, and they reject a second write to the root or to an existing `rev`. The locator is not a grant and not a second Check object. The Check object id stays `s3rch/items/<itemId>`.
- **Revision manifest location.** The signed manifest for `rev` is stored at `s3rch/items/<itemId>/m/<rev>`. It is not inside `ct`, and it is not only in the author lane, because a grantee has to fetch it before accepting the envelope. The node is `{ v: 1, manifest, msig }` where `manifest` is `{ itemId, e, rev, parent, keyId, envDigest, statusAuthPub }` and `msig` is the account-key signature over the canonical manifest bytes (`statusAuthPub` omitted when absent). The node does not carry an account pub. `statusAuthPub`, when present, is the SEA pub of the status authority for this revision; when it is absent only the account key may sign status for this revision. The wrapped-key grant names this soul. Readers fetch that soul, check `msig` under the account key that is current at check time, and reject the item when the node is missing, the soul is not `s3rch/items/<itemId>/m/<rev>` for the grant's item and `rev`, or `envDigest` does not match the envelope at `s3rch/items/<itemId>/r/<rev>`. A failed `msig` is not repaired by writing a second signature at the same soul. Account-key rotation publishes a successor revision instead (see *Device enrollment and revocation*). The manifest is not a grant.
- `ct` is the SEA/AES-GCM ciphertext of the existing `GunFeedNode` body (or room / claim node). `ver` matches the SociACL object version.
- Authorship is hidden by default: `owner` is not on the wire for private items. It sits inside `ct` and inside each wrapped-key entry. See *Author fast path* and *CHECK without a visible owner*.
- Public items stay `v: 1` plaintext on `s3rch/items`. Encryption is per item, not per network.
- **Owner authentication of the ciphertext.** Every grantee of a shared item knows `K_item,e`, so AES-GCM only proves the writer held the content key, not that the owner wrote the content. Inside `ct`, the body therefore carries `osig`, the owner's SEA signature over `(itemId, e, rev, H(unsignedBody))`, where `unsignedBody` is the canonical serialization of the body with the `osig` field omitted. The same `rev` names the manifest at `s3rch/items/<itemId>/m/<rev>`, whose `envDigest` is `H(itemId || e || rev || alg || iv || ct)`. `msig` and `osig` must verify under the account key that is current when the reader checks them. Readers reject any item whose envelope digest does not match that manifest, so a grantee cannot write a replacement node, forged `owner` included, at the same path. Relays reject a second write to `s3rch/items/<itemId>/r/<rev>`, to `s3rch/items/<itemId>/m/<rev>`, and to the root locator, so a dominating HAM update cannot displace a valid revision and a later account key cannot replace `msig` in place.

### Content keys and epochs

- One random 256-bit content key `K_item,e` per item per epoch `e`.
- The epoch bumps on every revoke (and on SociACL object version bump caused by privilege-down). New content after a revoke is encrypted under the new key.
- Old ciphertext stays under the old key unless the owner re-encrypts (see Revocation).
- **Serializing epochs across devices.** Every enrolled device holds the account key, so two devices could each pick a different random key for `e+1`. Each rotation is therefore an owner-signed revision manifest `{ itemId, e, rev, parent, keyId = H(K_item,e), envDigest = H(itemId || e || rev || alg || iv || ct), statusAuthPub? }` with a unique `rev` id and a `parent` pointer to the manifest it supersedes. The manifest is written at `s3rch/items/<itemId>/m/<rev>` and the envelope it binds is written at `s3rch/items/<itemId>/r/<rev>`, including when `rev` is the first revision. Wraps and grant proofs name the `keyId` they carry and the manifest soul `s3rch/items/<itemId>/m/<rev>`. If two manifests claim the same `e` with the same parent, the winner is chosen deterministically (lowest `H(manifest)`). Where an owner uses a status authority (see *CHECK without a visible owner*), the authority's signed head is the tie-breaker instead, and clients follow it, and the losing device re-wraps its content under the winner's key once it sees the conflict. The authority's signature is accepted only when `statusAuthPub` on that manifest matches an owner-signed status-authority binding. A device must have synced the latest manifest for an item before it writes new content; content that names a superseded manifest (for example from a device that was offline during a rotation) is rejected by readers and must be re-issued under the current epoch.

### Wrapped-key grant (inbox entry)

```
s3rch/inbox/<tag(readerEpub, slot)>/<entryId>
  { v: 1, eph, ct, iv, wsig }    // ECDH(eph, readerEpub) → AES-GCM
plaintext of ct:
  { item: <itemId>, e, rev, keyId, key: K_item,e, owner, grantSoul?, from, until?, manifest, sig }
```

- **Writer-authenticated, immutable entries.** The per-pair tag hides the lane but is not a write ACL, and the relay serving the reader learns tags and entry ids. Each entry therefore carries `wsig`, a signature over `(tag, entryId, H(eph || ct || iv))` by a per-lane writer key `W = derive(ECDH(senderPair, inboxPub), "writer")`. The writer pub is never published next to the lane or on the reader's account node, since that would link the lane to the reader. The reader gives it only to the relays it chooses, over a private authenticated subscription, and those relays reject entries without a valid `wsig`. Entries are write-once: relays refuse any update to an existing `entryId`, and readers keep the first valid value they see and ignore later conflicting ones, so a dominating HAM update cannot replace a legitimate entry.
- Wrapping uses SEA's ECDH (`SEA.secret(readerEpub, ephemeralPair)`) with a fresh ephemeral pair per entry, then `SEA.encrypt`. The entry is unlinkable to the sender on the wire.
- `sig` is the owner's SEA signature over the grant tuple `(item, e, rev, keyId, manifest, reader pub, from, until, object version)`. `manifest` is the soul `s3rch/items/<itemId>/m/<rev>` for that same `item` and `rev`. This is the exact tuple the grant proof below refers to, so the reader can tell a real grant from junk, can fetch the manifest, and can present the proof to CHECK. A grant that omits `manifest`, or whose `manifest` is not that soul, is rejected. The manifest reference is not itself a grant.
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

- The wrapped-key entry carries a **grant proof**: the entry's `sig` over the grant tuple `(itemId, e, rev, keyId, manifest, accessor pub, from, until, object version)`, plus the owner's account-key binding (the current SEA pub, attested by the login provider or wallet). `manifest` is the soul of the revision manifest. The accessor identity in that tuple is the accessor's SEA pub.
- The reader decrypts the entry and runs CHECK locally against that proof, which holds the same facts as today's `IdentitySeeGrant`. It's the reader's own client checking its own access.
- When a peer or relay must authorize an action (a reply, a write into a group, a server-side action), the reader presents the grant proof to that verifier over a direct channel. The verifier learns the owner for that one item only. The mesh at large never sees it.
- **Proof of possession.** The grant proof names the accessor but does not show that the presenter controls that accessor's key, so a leaked proof could be replayed. The verifier sends a fresh nonce, and the presenter returns the proof plus a signature over `(nonce, verifier id, H(proof))` made with the accessor's SEA private key. The verifier checks that signature against the accessor pub named in the proof and checks that pub against the account-key log head. A cached older pub does not pass.
- **Revocation and freshness.** The owner publishes a revocation token `H(itemId || epoch || accessor || nonce)` under the author lane or an item-keyed revocation lane. Absence of a token in an eventually replicated graph does not prove a grant is live, because a stale or partitioned verifier may not have received it yet. For server-side actions, the verifier therefore needs positive freshness: a status statement `{ itemId, e, rev, issuedAt }` that names the current revision manifest. To keep stale devices from vouching for a revoked epoch, status issuance is serialized with rotation: statements are signed either by an online status authority the owner designates, which accepts a manifest only if its `parent` is the head it already holds and then signs statements only for that head, or by an owner device after it has confirmed the current head with that authority. The authority serializes sibling manifests itself: it accepts the first valid child of its head, signs that as the new head, and owner devices that lose re-issue under it, so clients and the authority agree on one head. Verifiers require the grant proof's `rev` and `keyId` to equal the head named in the statement, and the statement must be no older than a short window (for example 5 minutes). Without a fresh statement the verifier refuses the action. An authority signature is accepted only under the status-authority binding below, and only for the account that owns the grant. Revocation is then immediate up to that window for verifiers that require freshness. Reader-side display, which works offline, only stops at the next epoch the reader learns about; that weaker guarantee is accepted for offline reads. A status statement is not a grant.
- **Status authority binding.** The account identity is its current SEA pub. A status statement does not mint a grant, does not change that pub, and is not an identity. The grant owner is the account whose current account-key log head verifies the grant signature. The verifier fetches that log head first. The pub that verifies the grant `sig`, and the pub that verifies `msig` on the manifest soul the grant names, must equal that head's `keyPub`. That head's `account` is the owner account. A presenter-supplied account id that does not match this head is ignored. A statement signed by that owner's current account key is accepted on its own. A statement signed by any other key, including another account's current key or another account's status authority, is accepted only when that key is the status authority this owner has named:

  ```
  StatusAuthorityBinding {
    account,        // grant owner's provider:encoded-id
    accountPub,     // grant owner's current SEA pub; signs this binding
    statusAuthPub,  // designated SEA pub
    bindSeq,        // 0, then +1; independent of the account-key log
    prev            // H(previous binding), or "none" at bindSeq 0
  }
  ```

  The account key named by `accountPub` signs the canonical binding. `bindSeq` is not the account-key `seq`. Two bindings signed by the same account key are ordered by `bindSeq`, and the presenter does not choose which one is current. The login provider or the wallet signs a binding head `{ account, bindSeq, entryHash }` over the latest binding for that same account, the same way it signs the account-key log head. The SEA key does not sign that head. The verifier fetches this head for the grant owner's account. It does not fetch a head for an account the presenter names. The presenter carries the head binding on the same direct channel as the status statement. The binding is not written on the item root, and the manifest node still does not carry an account pub.

  Verifiers accept an authority-signed statement only when all of the following hold:

  1. The verifier has fetched the binding head for the grant owner's account, and a chain of bindings that links it to `bindSeq` 0 or to a binding this verifier already accepted on an earlier successful check for that same account. The head's `account` equals the grant owner's account. The head signature, `entryHash`, and each `prev` match. A head whose `account` is any other account is refused before `statusAuthPub` is compared. If the head cannot be fetched, the chain does not link, a `prev` mismatches, the head's `account` is not the grant owner, or the provider or wallet does not answer, the verifier refuses every statement that is not signed by the grant owner's current account key. It does not keep a cached binding.
  2. The presented binding is that head. A lower `bindSeq`, including one the same account key signed, is refused.
  3. `binding.account` equals the grant owner's account. `accountPub` on the head binding equals that owner's current account-key log head, the same pub that verifies the grant `sig` and `msig`. The binding signature verifies under that pub. A binding whose `account` or `accountPub` names any other account is refused.
  4. The statement's signing key equals `statusAuthPub` on that owner-bound head and equals `statusAuthPub` on the manifest at `s3rch/items/<itemId>/m/<rev>` for the statement's `rev`. Equality of `statusAuthPub` alone does not accept the statement.

  Replacing the authority appends a new binding for this owner and moves this owner's head. It does not require an account-key rotation. An immutable manifest that still names the previous `statusAuthPub` then fails check 4, so the previous authority cannot sign a fresh statement for that revision. The grant owner's current account key may still sign status for that revision on its own. A successor revision may name the new `statusAuthPub` in a new manifest; the old manifest is not rewritten. An account-key rotation also drops every binding whose `accountPub` is not the new account-key head. Another account's binding head, even one whose `statusAuthPub` equals the pub still named on this owner's immutable manifest, does not authorize a statement for this grant. The authority pub cannot sign manifests, grant proofs, or a replacement binding, and it cannot mint `see`. Hop, status, and chat never mint a grant.
- This needs the SociACL "private discovery" addition (spec section below). Current SociACL CHECK reads a plaintext graph.

### Groups

The light contract has no group predicate yet, so v1 has two modes:

- **v1 (fan-out):** a "group" is a client-side list; the owner writes one wrapped-key entry per member. Correct under hopcap 1, cost O(members) per item.
- **v2 (group keys, needs SociACL `same-group` on the light surface):** each group has a group key pair per epoch `G_g,e`. Members receive `G_g,e` once in their inbox. Items for the group wrap `K_item` to `G_g,e.epub` once. Cost O(1) per item, O(members) per membership change. Members are still hop 1 (direct members only; no nested groups). The group key encrypts. It does not authenticate a sender, and holding it does not mint a membership or a grant.
- **Group inbox write authentication.** An ordinary entry is stored at `s3rch/ginbox/<tag(G_g,e)>/<entryId>` as `{ v: 1, senderPub, eph, ct, iv, ssig }`. `ssig` is the sender's account SEA signature over `(tag, entryId, senderPub, H(eph || ct || iv))`. The signing key is that sender's current account SEA pub. A key derived from `G_g,e`, including `derive(ECDH(member, G_g,e.epub), "writer")`, is not a writer credential: every member can compute it, so it must not stand in for the sender. Relays and members check `ssig` under `senderPub` before they store or unwrap the entry, and they drop a bad signature before decryption. Relays also require `senderPub` to be in the current epoch's member set, which the group owner gives them over a private channel, and they require that pub to be the account's current SEA pub under the account-key log. A fresh pair that only signs for itself is not a member. Entries stay write-once. Members and the relay that stores the tag learn `senderPub`. The tag still hides the lane from non-members. `ssig` authenticates the append. It is not a grant, not a membership edge, and not `see`. Hop, status, and chat never mint a grant. The per-pair inbox writer key `W` is not used on this path.
- **Group-inbox hand-over.** A v2 reissue is not an ordinary entry signed by only one account key. The new key is not current yet, so a relay that admits only the current key rejects `ssig` under the new key. An entry signed only by the old key fails the reader's current-key check once the head moves. The hand-over therefore writes one staged entry before the head moves, and members accept that same entry after the head moves. The entry is `{ v: 1, senderPub, nextPub, eph, ct, iv, ssig, ssigNext }`. `ssigNext` is the new account key over `(tag, entryId, nextPub, H(eph || ct || iv))`. `ssig` is the current account key over `(tag, entryId, senderPub, nextPub, H(eph || ct || iv), ssigNext)`. The inner grant `sig` is the new account key and names the successor manifest. The provider or wallet first publishes a pending successor `{ account, keyPub, seq, prev, stage: "pending" }`, signed by that provider or wallet, with `seq` one past the account-key head, `prev` the hash of the head entry, and `keyPub` the new pub. That record is not the log head. Signatures under `keyPub` are not accepted in general. A relay admits the staged entry only when it has fetched the head and this pending record, `senderPub` is the head, `senderPub` is in the member set, `nextPub` equals the pending `keyPub`, both signatures verify, and the fetch succeeded. If either fetch fails, the relay refuses the append. It does not store an entry signed only by the new key, and it does not treat a successor named only by the old SEA key as pending. After the head names `nextPub`, a member accepts the staged entry when `ssigNext` verifies under that head. `ssig` alone does not authenticate it. An ordinary entry whose `ssig` is the previous key is ignored. The member then unwraps and fetches `m/<rev'>`. No second group-inbox write is required. The staged entry is not a grant.

## Discovery flow

```
reader                              shared graph / relays
  |  for each known lane tag t:            |
  |---- get s3rch/inbox/<t>  (since cursor) -->
  |<--- entries (ciphertext only) ----------|
  |  unwrap; verify grant proof             |
  |  CHECK(see, item, me) on grant proof    |
  |---- get grant.manifest --------------->|   (s3rch/items/<itemId>/m/<rev>)
  |<--- manifest, msig ---------------------|
  |  msig under the current account key
  |---- get s3rch/items/<itemId>/r/<rev> -->|   (first revision uses this path too)
  |<--- ct -------------------------------- |
  |  envDigest matches; decrypt with K_item,e; index locally
```

- **Pagination:** inbox entries are keyed `<entryId> = <hlc>-<rand>` (hybrid logical clock prefix), so a reader reads by lexical range. Gun has no native range queries; use the `gun/lib/lex` `.get({'.': {'>': cursor}})` form, which relay peers can serve, and fall back to full-node fetch on peers that ignore it.
- **Incremental sync:** HLC keys are only monotonic per device, and one account can write from several devices or restore a stale clock, so the greatest key seen is not a lossless cursor. Each entry also carries a per-device id and sequence number inside `ct`, and the reader keeps a per-tag, per-device high-water mark. On login and on reconnect the reader rescans each daily shard it has not marked complete and deduplicates by `entryId`; a shard is not closed by an empty rescan. The reader keeps rescanning each daily shard for a retention window (for example 30 days), and a shard can close early only on close markers from every writer device of the sender account: each enrolled device signs its own marker `{ lane, day, deviceId, lastSeq }` with its device key, and the reader closes the shard once it holds a marker from every device in the sender's current device records and every listed sequence. A missing marker from any device keeps the shard open for the full window. The lex `> cursor` query is an optimization for live updates, never the only path. The reader also subscribes (`.map().on`) to its active tags.
- **Multi-device:** one SEA key pair per account. Senders wrap only to the account epub, never per device. See *Device enrollment and revocation*.
- **Manifest check.** The reader checks `msig` under the account key that is current for this fetch. Failure rejects the grant. The reader does not look for another signature on that soul. After an account-key rotation, the grant that passes names the successor soul `s3rch/items/<itemId>/m/<rev'>`.
- **Status check.** The verifier authenticates the grant owner from the grant signature under that owner's current account-key log head, then fetches the status-authority binding head for that account. `binding.account` and the head's `account` must equal that owner, and `accountPub` must equal that owner's current key. A head for any other account is refused before `statusAuthPub` is compared. A presented binding with a lower `bindSeq` is refused, including when the same account key signed it. If that head cannot be fetched, authority-signed status is refused. A statement signed by the grant owner's current account key still follows the account-key log rule. A statement signed by any other account's key is refused.
- **Group discovery (v2):** read group inbox tags for each held `G_g,e`. For an ordinary entry, verify `ssig` under the sender's current account key before unwrapping. For a staged hand-over entry, after the account-key head has moved, verify `ssigNext` under that head and ignore `ssig` as the writer credential. A signature under the shared group key is not either check. The unwrapped grant names the successor manifest.
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
- The account identity for manifests, grant proofs, status statements, status-authority bindings, and group-inbox `ssig` is the current SEA pub. That pub is the head of an append-only binding log kept by the login provider or the wallet, not the highest `seq` a verifier has cached. Each entry is `{ account, keyPub, seq, prev }` where `seq` starts at 0 and then increases by 1, and `prev` is `H(previous entry)` or `none` for seq 0. The provider or the wallet signs a head `{ account, seq, entryHash }` over the latest entry. The SEA key does not sign that head. A competing successor signed only by the old SEA key is ignored. Before trusting a signature, the verifier fetches the head and a chain of entries that links it to seq 0 or to an entry the verifier already accepted on an earlier successful check. It checks the head signature, checks `entryHash`, and checks each `prev`. It then accepts signatures only under the head's `keyPub`. A lower `seq` is history. It does not authenticate a new manifest, grant proof, status statement, authority binding, or `ssig`. If the head cannot be fetched, the chain does not link, a `prev` mismatches, or the provider or wallet does not answer, the verifier refuses. It does not fall back to the highest cached `seq`. Offline display may keep bytes already decrypted under a key that was current when they were checked. It does not accept a newly presented signature while this check cannot complete. Server-side actions refuse when the check cannot complete. The binding is not a grant. Hop, status, and chat do not change the head and do not mint a grant.
- Re-key before abandoning the old key. A trusted device, still holding the old pair and the new pair, publishes the successor objects below before the provider or wallet appends the new account-key head. It does not write a new `msig` onto an existing manifest soul. Relays reject that write. For each item the account owns, the device publishes a successor revision `rev'` with `parent` equal to the current `rev`:
  - A new manifest at `s3rch/items/<itemId>/m/<rev'>`, signed by the new account key. The old node at `m/<rev>` stays as it was.
  - A new envelope at `s3rch/items/<itemId>/r/<rev'>`. `osig` and `envDigest` bind `rev'`, so this is a new encryption of the same plaintext. The same epoch and the same `keyId` are allowed when the hand-over is only an account-key rotation. The old envelope stays at `r/<rev>`.
  - A reissued personal-inbox wrap and grant proof for each current grantee. The outer `wsig` uses that lane's writer key, which is not the account key, so the relay can store it while the old key is still the head. The inner grant `sig` is the new account key. The grant names `rev'` and `manifest` = `s3rch/items/<itemId>/m/<rev'>`. Readers accept that inner `sig` only once the head names the new key. The author lane gets a new self-wrapped entry for that successor.
  - A staged group-inbox entry for each v2 group share, as defined under *Group inbox write authentication*. It is written after the provider or wallet has published the pending successor and before the account-key head moves. `ssig` is the old key and `ssigNext` is the new key. The relay admits it only for that pending successor. Members discover `rev'` from this entry after the head moves by checking `ssigNext`.
  - A new status-authority binding signed by the new key, with `bindSeq` one greater than the previous binding and `prev` equal to that binding's hash, when the account uses a status authority.
  The succession record lets other grant owners reissue active wraps and grant proofs to the new pub. Signatures under the new key are accepted only once the account-key head names it. Signatures under the old key, including `msig` on `m/<rev>`, are refused once that head is visible. A reader or verifier fetches only the manifest soul named by the grant it is checking. When `msig` does not verify under the current account key, it rejects that grant. It does not read a second signature from the same soul, and it does not treat the root locator as a newer manifest. The successor is the reissued grant. Its `parent` must be the previous `rev`. A fresh fetch fails closed until that grant arrives. Bytes already decrypted under the old manifest may stay on the device. A verifier that cannot read the account-key head refuses signatures under both keys. Re-enrolled devices receive the old pair only for the duration of this hand-over, and it is deleted once the re-wrap completes.
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
- **Tombstones:** entries are write-once, so a tombstone is a new entry in the same lane, under a new `entryId` and with its own `wsig`, that references the original `entryId`. A group-inbox tombstone carries `ssig` by the sender's current account key instead of a signature under the shared group key. A tombstone written in the same hand-over window uses the staged `ssig` and `ssigNext` pair. Readers drop keys for tombstoned entries.
- **Batching:** owners revoking several readers at once do one rotation.
- Group v2 removals are the expensive case: one rotation per removal, O(members). Large groups may want tree-based group key agreement (e.g. MLS/TreeKEM, O(log n)), out of scope for v1.

## Performance on Gun

- **Fan-out:** v1 writes one inbox entry per reader per item. Fine for personal sharing (tens of readers). Groups beyond ~50 members should wait for v2 group keys.
- **Reads:** a reader touches only its own tags plus the items it can decrypt. No global scan. Each entry costs one ECDH to unwrap; there is no trial decryption of other readers' entries.
- **Caching:** clients cache decrypted items and keys in IndexedDB (encrypted at rest with a key derived from the SEA pair). Relays cache ciphertext only.
- **Relay roles:** the `/gun` seed peer and any durable relay (`docs/durable-graph-and-turn.md`) store and serve ciphertext and inbox entries, may enforce write rate limits and size caps, and never hold content keys. Optional "mailbox relays" can be chosen per user to keep inbox tags off the general mesh. Relays must not mint `see` (existing rule).
- **Gun limits:** large nodes and wide maps replicate poorly; shard inbox tags by day and item ciphertext by chunk if over ~64 KiB.

## Federation

- **Identity:** a principal is its current SEA pub. The login provider or wallet attests that pub as the head of the account-key log. A hop, a status statement, and a chat node do not mint a grant and do not change that pub. Accounts are `provider:encoded-id` (see the provider-ID encoding in #106). Any login provider in `S3RCH_LOGIN_PROVIDERS` (Panopticon, Entra, another org's OIDC) produces a SEA binding the same way SIWE does today.
- **Cross-org sharing:** an owner wraps to any SEA pub, regardless of the reader's provider. CHECK accessor ids carry the provider prefix, so grants never collide across providers.
- **Org-run relays:** each org can run its own seed/mailbox relay; Gun peers replicate across them. Org policy (who may write to members' lanes) is enforced at that org's relay and by CHECK.
- **Org groups:** v2 groups may be owned by an org principal; membership still hop 1.

## Proposed SociACL spec additions

These are proposals for FyberLabs/SociACL. The matching spec change is [FyberLabs/SociACL#20](https://github.com/FyberLabs/SociACL/pull/20) (wrapped-key grants); none of it is implemented in s3r.ch yet. Item 2 also covers the reader-side grant proof and revocation tokens described under *CHECK without a visible owner*.

1. **Wrapped-key grant edge.** A `delegate`/see grant variant that carries `{ epoch, wrappedKey, recipientKeyId }`, signed by the owner. CHECK semantics unchanged; the edge additionally lets the recipient decrypt epoch `e`. Defines which key types are allowed (SEA P-256 epub to start).
2. **Private discovery.** A storage rule that grant rows need not be plaintext: an encrypted/blinded `MeshSeeGrant` form that the accessor (and optionally a designated verifier) can present to CHECK as a signed grant proof, so CHECK can be evaluated without publishing `s3rch/acl/<owner>/<object>/<accessor>` in clear. Includes the inbox tag derivation.
3. **Rotation on revoke.** Make `cancelSee` / `undelegate` on an encrypted object require an epoch bump and a re-wrap to remaining grantees; CHECK denies decryption-dependent actions for any grant on an older epoch.
4. **Group predicates on the light surface.** Add `same-group` (and possibly `named-circle`) to `s3rch-check.d.ts`, hop 1, with a group-key epoch tied to group membership changes. The group epoch key encrypts. It does not authenticate a group-inbox writer and it does not mint a membership.
5. **Envelope path for every revision.** The Check object id stays `s3rch/items/<itemId>`. Ciphertext, including the first revision, is fetched from `s3rch/items/<itemId>/r/<rev>`. There is no root-ciphertext fallback. The root locator is not a Check object and not a grant.
6. **Manifest soul on the grant.** The signed grant tuple includes `manifest` = `s3rch/items/<itemId>/m/<rev>`. CHECK on a presented proof rejects a grant whose manifest soul is missing or does not match that item and `rev`. The manifest node is outside `ct` so `envDigest` is checked before the body is accepted. An author-lane copy alone does not satisfy a grantee. Account-key rotation does not rewrite that soul. It publishes `m/<rev'>` and reissues the grant to name it. `msig` must verify under the account key that is current at check time. A failed `msig` rejects the grant.
7. **Status authority binding.** `StatusAuthorityBinding` (below) is signed by the grant owner's current account SEA pub in `accountPub`. `bindSeq` is an independent monotonic sequence. The provider or wallet signs the binding head `{ account, bindSeq, entryHash }` for that same owner account. The verifier authenticates the grant owner as the account whose current account-key log head verifies the grant signature, then fetches the binding head for that account. A status proof signed by any other key verifies only when the head's `account` and `binding.account` equal that owner, `accountPub` equals that owner's current account key, the presented binding is that head, and `statusAuthPub` equals both the head binding and the manifest for that `rev`. A head or binding for any other account is refused before `statusAuthPub` is compared. A lower `bindSeq` signed by the same account key is refused. If the binding head cannot be fetched, authority-signed statements are refused. A statement signed by the grant owner's current account key is accepted on its own. A statement signed by any other account's key is refused. The authority key is not an account identity. The proof still does not mint a grant. Hop, status, and chat still do not mint. Replacing the authority moves this owner's head and does not require an account-key rotation.
8. **Group-inbox sender signature.** An ordinary v2 group-inbox entry carries `ssig` by the sender's current account SEA pub over `(tag, entryId, senderPub, H(eph || ct || iv))`. A signature under a key derived from the shared group key is rejected before unwrap. During account-key rotation the reissue is a staged entry with `ssig` under the still-current key and `ssigNext` under the pending successor. The provider or wallet signs that pending successor. It is not the log head. Relays admit the staged entry only when both signatures match that pair. After the head moves, readers accept `ssigNext` under the new head and ignore an entry signed only by the old key. `ssig` and `ssigNext` do not mint `see` or a membership.
9. **Current account key, fail closed.** Verifiers resolve the provider or wallet append-only log head `{ account, keyPub, seq, prev }` and a hash chain back to genesis or to an entry already accepted. If that check cannot complete, they refuse. The highest cached `seq` is not the current key. A superseded SEA pub does not authenticate new manifests, grant proofs, status statements, authority bindings, or group-inbox `ssig`. The identity those signatures use is that SEA pub. The log entry is not a grant.

These five additions are the consume-contract deltas for the open SociACL docs follow-up. They are not in the copied [s3rch-check.d.ts](s3rch-check.d.ts) in this repo. s3r.ch does not import the SociACL crate. Re-typed shapes, for that follow-up to copy:

```ts
/** Product envelope. Not a second Check object. First rev uses this path too. */
type ItemRevisionSoul = `s3rch/items/${string}/r/${string}`;

/** Signed manifest node. Not a grant. No account pub on the node. */
type RevisionManifest = {
  itemId: string;
  e: number;
  rev: string;
  parent: string;
  keyId: string;
  envDigest: string;
  /** Absent when only the account key may sign status for this head. */
  statusAuthPub?: string;
};

/** Grant tuple field. Soul of the manifest for this item and rev. */
type ManifestSoul = `s3rch/items/${string}/m/${string}`;

/**
 * Grant-owner designation of the status authority.
 * Signed by that owner's current account SEA pub.
 * account and accountPub equal that owner and that key.
 * Not an identity. Not a grant.
 */
type StatusAuthorityBinding = {
  account: string;
  accountPub: string;
  statusAuthPub: string;
  /** Independent of AccountKeyLogEntry.seq. */
  bindSeq: number;
  /** Hash of the previous binding, or "none" at bindSeq 0. */
  prev: string;
};

/**
 * Provider or wallet head for StatusAuthorityBinding.
 * account is the grant owner. The presenter does not choose another account or a lower bindSeq.
 * Not a grant.
 */
type StatusAuthorityHead = {
  account: string;
  bindSeq: number;
  entryHash: string;
};

/**
 * Group-inbox writer authentication.
 * Signed by the sender's current account SEA pub. Not a grant.
 */
type GroupInboxWriteSig = {
  tag: string;
  entryId: string;
  senderPub: string;
  bodyHash: string;
};

/**
 * Write-once v2 reissue around an account-key rotation.
 * ssig is the still-current key and covers ssigNext.
 * ssigNext is the pending successor. Not a grant.
 */
type GroupInboxHandover = {
  senderPub: string;
  nextPub: string;
  ssig: string;
  ssigNext: string;
};

/**
 * Provider or wallet announcement of the next account key.
 * Not the log head. Does not make keyPub current.
 */
type PendingAccountKey = {
  account: string;
  keyPub: string;
  seq: number;
  prev: string;
  stage: "pending";
};

/**
 * Append-only account-key log entry. Identity is keyPub.
 * prev is the hash of the previous entry, or "none" at seq 0.
 * Not a grant.
 */
type AccountKeyLogEntry = {
  account: string;
  keyPub: string;
  seq: number;
  prev: string;
};
```

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
8. **Resolved:** the SociACL additions are proposed upstream in [FyberLabs/SociACL#20](https://github.com/FyberLabs/SociACL/pull/20). The further consume-contract deltas from [#113](https://github.com/FyberLabs/s3r.ch/issues/113) are re-typed in this document. They are not a second pull request against SociACL from this change.
9. **Resolved:** the first ciphertext envelope is stored at `s3rch/items/<itemId>/r/<rev>`. Readers do not fall back to ciphertext on the root.
10. **Resolved:** the revision manifest is stored at `s3rch/items/<itemId>/m/<rev>` and the grant tuple names that soul. That node is immutable. Account-key rotation publishes a successor revision and reissues grants. It does not replace `msig`.
11. **Resolved:** a status authority signs only when the provider or wallet binding head is the grant owner's head, that head's `account` and the binding's `account` equal that owner, `accountPub` is that owner's current account key, and the manifest for that `rev` names the same `statusAuthPub`. `bindSeq` is independent of the account-key log. A superseded binding is refused. Another account's head does not authorize the statement.
12. **Resolved:** a v2 group-inbox append requires `ssig` by the sender's current account key. The shared group key does not authenticate the sender.
13. **Resolved:** a verifier accepts account-key signatures only after it has checked the provider or wallet log head. If that check cannot complete, it refuses. A cached lower `seq` is not accepted as current.
14. **Resolved:** after the account-key head moves, readers verify `msig` only under the new key and only at the manifest soul named by the reissued grant. The previous manifest soul is left unchanged.
15. **Resolved:** replacing a status authority appends a binding and moves that owner's binding head. Authority-signed status for a manifest that still names the previous pub is refused. The grant owner's current account key may still sign that status. A successor revision may name the new pub.
16. **Resolved:** a v2 group-inbox reissue is one staged entry written before the account-key head moves. The relay admits it for a provider-signed pending successor. After the head moves, members accept `ssigNext` under the new key. An entry signed only by the old key is ignored, and an entry signed only by the new key is not stored early.
17. **Resolved:** the status-authority head is fetched for the account whose current account-key log head verifies the grant signature. `binding.account`, the head's `account`, and `accountPub` must equal that grant owner and that owner's current key. A head for any other account is refused before `statusAuthPub` is compared.
