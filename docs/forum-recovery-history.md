# Squad recovery-history verification

`lib/identity/forum-recovery-history.ts` authenticates raw recovery evidence and
returns an immutable history projection plus an exact-time `ForumRecoveryProvider`.
It implements the verification scope of #185. App graph admission, live transport
and deployment remain #186 and #190; the public-fixture Squad mesh remains disabled.

## Input trust boundary

`resolveForumRecoveryHistory(principal, snapshot, trustedKeys, policy, pinnedIssuers, at)`
requires an independently trusted source to provide:

- The complete wallet/OIDC candidate index through `snapshot.completeThrough`.
- Each relevant account's raw rotations, witnessed genesis encryption-key
  bindings and revocations through that same instant.
- Independently configured witness keys with authorization windows, SIWE
  domain/URI/chain policy and pinned OIDC issuers.

`completeThrough` is a transport assertion, **not a cryptographic proof**. Never
accept that assertion from an arbitrary Gun peer or infer completeness from an
empty response. The verifier rejects absent accounts, missing lists and a
watermark earlier than `at`; it cannot detect omitted rows in a falsely asserted
complete snapshot. The production source, its freshness/completeness guarantee,
configuration and deployment verification belong to #190.

All records and policy are detached before asynchronous verification. The module
performs no network requests or implicit key discovery. Each call starts afresh;
there is no authority cache spanning calls. The returned provider answers only
for the requested principal and exact evaluation time. Re-fetch and re-verify
when either changes. Failure exposes no provider or partial key projection.

## Resolution

Rotations are grouped by sequence after independent next-key signature and exact
witness-claim verification. Malformed/forged entries are diagnostic. For each
candidate, the resolver checks key continuity, strict time ordering, signing-key
and encryption-key reuse, authorizer eligibility, and every retained link against
the authenticated prefix. Retention commitments intersect; a later commitment
cannot resurrect a previously dropped link.

Wallet recovery requires a SIWE proof bound to the exact rotation bytes and the
newest eligible wallet link across the complete address index. Independent wallet
proofs are checked before resolving a candidate's foreign principal, so forged
index entries cannot force missing-history failures. Foreign histories are
verified recursively from raw evidence. Missing or cyclic dependencies deny.
Equal-time distinct newest links conflict.

OIDC fallback requires a pinned, witnessed enrolled credential, the exact
rotation witness certifying fresh login, and no active own wallet in the
pre-transition state, including wallets the candidate proposes to drop. An
OIDC link or a provider label alone does not authorize rotation.

Historical revocations require timestamp witnesses and signatures under the
key at revoke issuance, including exact rotation boundaries. An offline revoke
cannot rewrite an earlier rotation. The returned provider preserves raw revoke
evidence for the existing eligibility consumer: present lookups additionally
honor current-key offline revokes, while retired-key offline signatures cannot
backdate revocation.

Signed transition identities are deduplicated after verification. A damaged
unsigned proof copy cannot veto a valid copy of the same identity. Distinct
unresolved authenticated identities deny; multiple valid transition identities
freeze resolution as a rotation fork. Genesis encryption-key bindings are
witnessed and signed; conflicting early bindings freeze resolution. Bindings
at or after the first accepted rotation do not replace the genesis binding.

## Upstream provenance and consumer restrictions

The source contract is FyberLabs/SociACL commit
`b7f9bc59e800fef8420c9ced8040c925ef7ceac7`, `typescript/ids/src/records.js`
and `ids.js`. No SociACL package or runtime is imported.

All 147 upstream `resolve` cases are copied verbatim into a pooled fixture.
Regenerate it from a local upstream checkout with:

```sh
python3 scripts/fixtures/copy-forum-recovery-vectors.py /path/to/SociACL
```

The consumer intentionally differs at these boundaries, explicitly asserted in
the tests rather than changing the source fixtures:

- Authenticated sequence gaps deny with `missing-history`. Authenticated
  signing/encryption-key reuse or continuity conflicts deny the whole projection;
  they do not return the preceding key as the upstream fixtures do.
- Genesis bindings dated after the exact evaluation instant are excluded even
  within SIWE clock skew. Skew does not advance a history projection.
- The upstream foreign-history fixture supplies an already trusted projection
  without its authorizing OIDC link. This raw-history API denies that incomplete
  evidence; a separate test supplies and verifies the complete foreign chain.
- Oversized lists report `bad-input` rather than upstream `too-long`.
- Witnessed revocation verification uses each revoke's historical signing key,
  preserving the consumer's previously reviewed retirement protection.

## Resource bounds and validation

Each input list is limited to 1,024 entries; there are at most 128 accounts,
4,096 aggregate account/evidence entries, 65,536 retained-ID references and
64 active cross-account resolution frames. A call has a 16,384-unit work budget,
including revocation scans. Exceeding a bound denies the whole lookup, never a
truncated prefix. Diagnostics identify principal, source, list index and reason;
repeated reports are deduplicated.

Tests cover upstream vectors plus complete raw foreign histories, missing and
stale snapshots, policy/record mutation during awaits, accessors, duplicate
accounts, newest-link ambiguity, OIDC fallback, retention, historical versus
present revocation, exact-time provider use, recovery races and resource bounds.
These establish verifier behavior, not deployed transport completeness or live
Squad acceptance.
