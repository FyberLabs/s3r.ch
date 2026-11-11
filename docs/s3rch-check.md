# SociACL consume contract

[s3rch-check.d.ts](s3rch-check.d.ts) is an unmodified copy of the declaration
published by [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL).
[The provenance file](sociacl-contract.json) records its source repository, full
commit and the source path, local path and SHA-256 of each artifact. SociACL owns this contract; changes belong there
first. s3r.ch runs its browser consumer without importing the Rust crate or adding
a SociACL runtime package.

## Verification

`npm test` checks the declaration and the shared vector files against their
recorded SHA-256 values. The CI test job
also runs:

```sh
node scripts/check-sociacl-contract.mjs --upstream
```

That check downloads every recorded artifact from the same immutable commit and
compares bytes. Editing a local artifact and its hash cannot make a modified
copy pass. Missing or duplicate entries are rejected. Unavailable upstream or a failed comparison fails the check.
The `.gitattributes` rule prevents checkout line-ending conversion from changing
the source bytes.

This is source-contract provenance, not a deployed-service version requirement.
TEST services continue to track their latest merged default branches. No service
needs to run the same revision as this declaration.

## Updating the copy

1. Select and review a full SociACL commit containing the intended contract.
2. Download each source listed in `files` from that commit and replace its local
   `path` without editing or reformatting it.
3. Update `revision` and each file's SHA-256 of those exact bytes in
   `docs/sociacl-contract.json`.
4. Run the upstream verification command and `npm test`. Review consumer changes
   separately; updating the declaration does not establish implementation parity.

The initial synchronized source is
[`779c4d752c1f0afadc6b1b93b7f1f2535f3b4ffd`](https://github.com/FyberLabs/SociACL/blob/779c4d752c1f0afadc6b1b93b7f1f2535f3b4ffd/docs/s3rch-check.d.ts).
A later upstream commit does not silently change this copy. An explicit sync PR
must review the new contract and its impact on consumers.

## Remaining consumer work

This declaration is a reference artifact, excluded from the application compiler.
The current runtime is **not yet conformant** to all of it. In particular,
`lib/identity/check.ts` still contains wallet-based principal and soul helpers.
Forum need/offer transitions live in `lib/identity/forum-transitions.ts`; Squad
calls them explicitly, and they consume permission answers from Check. Check
does not import or re-export these state-changing operations. The synchronization replaces
old tests that required obsolete names and prohibited SEA/recovery concepts in
the reference artifact; existing runtime behavior tests remain in place.

[#281](https://github.com/FyberLabs/s3r.ch/issues/281) tracks removal of the legacy
`aclKey`, `aclPrincipalKey`, wallet user souls and wallet-keyed grant inboxes,
expanding shared-vector coverage beyond the families below, and replacing
the local transition implementation once the upstream consume surface is available.
[#277](https://github.com/FyberLabs/s3r.ch/issues/277) owns the SEA identity migration.
[Upstream #156](https://github.com/FyberLabs/SociACL/issues/156) tracks the missing
consume surfaces and vectors needed to replace local recovery, rotation,
witness and wallet-link copies with adapters. Synchronizing this file does not
close those issues or establish live authorization acceptance.

## Shared vector coverage

The same provenance check covers these upstream files:

| Upstream source | Local consumer and coverage |
| --- | --- |
| `vectors/ids/object.json` | `acl-souls.test.ts`: canonical object outputs and all parse-rejection cases at the grant-soul boundary; not minting or hash derivation. |
| `vectors/ids/principal.json` | `forum-principal.test.ts`: all accepted/rejected principal inputs, canonical path keys and inverse conversions. Other authority tests reuse these identities. |
| `vectors/mesh/forums.json` | `forum-check.test.ts`: forum souls, roles, tags, permission rejection, revocation, need/offer restrictions and cancellation. Squad/authority tests reuse the same fixture. `forum-shared-hint.test.ts` checks that the upstream hint fields cannot grant access. |

These JSON files are exact upstream copies, not app-specific fixture variants.
The forum vector's SGH1 binary `hint.hex` is preserved but is not decoded by this
consumer, which currently accepts structured hints. These families do not cover
all SociACL Check, recovery, rotation or wallet-link semantics. Adding a family
requires adding its source/local mapping to the verifier and its hash to the
manifest, then running its cases against the appropriate consumer.

## Canonical forum identity boundary

For canonical minted forum object IDs, `checkSee` and `checkForumSee` require
canonical SEA public keys for the accessor and any known owner before consulting
an authority callback. Wallet credentials, `s3rch/users/...` paths, path-key
spellings and malformed principal inputs cannot authorize those objects.
Fallback grants must name the exact object ID and SEA accessor; alias matching
cannot grant canonical forum access. Presented grants follow the same rule.
Owner-authorized grant creation/cancellation also requires the exact SEA owner.

SEA keys are never equivalent to legacy user-path aliases in `sameAccessor`.
The older wallet-based feed/user objects still use their existing identity path;
removing those paths and migrating their login/session consumers remains #277
and #281 work. These checks do not infer the current owner from the principal
embedded in an object ID; the graph remains responsible for verified ownership
and rotation history.

## Canonical ACL paths

The public `aclSoul` and `grantSoul` exports now follow the synchronized contract:
SEA principals become `p_` path keys and object IDs remain canonical, unchanged
segments. Invalid principals or object IDs return `null`; wallet credentials,
legacy user paths, raw claim strings and escaped object aliases are not encoded
into canonical ACL paths. Signed forum see/post records use the same constructor.
Path construction does not verify a signature or establish ownership.

The wallet-based feed mesh still uses explicitly named `legacyAclKey`,
`legacyAclPrincipalKey`, `legacyAclSoul` and `legacyGrantSoul` in
`legacy-acl-souls.ts`. These are not exported by Check. They preserve the current
feed transport until its identity/session migration in #277/#281; they must not
be used for new canonical records. Removing that legacy consumer remains open.

## Derived objects use the canonical Check boundary

The exact SEA-principal rules also apply to derived `claim_<hash>` and
`ext_<hash>` object IDs. They cannot acquire access through wallet identities,
user-path aliases or whitespace-normalized grant targets. Their owner still
comes from the admitted graph; the hash is not an ownership proof.

Check and ACL path construction share `object-id.ts` validation. Inputs in the
canonical minted/derived namespaces that fail validation (including reserved
minted kinds, uppercase encodings and invalid curve points) are denied before
any graph or authority callback. They do not fall through to legacy wallet
matching. The namespace discriminator is only a transitional routing rule, not
an object validator. Legacy feed/user object migration remains open.

## Legacy user storage and delivery inboxes

Check no longer exports `userSoul`, `grantedSoul` or `GrantInboxKind`.
The wallet-keyed feed/user consumers explicitly use `legacyUserSoul` from
`lib/identity/legacy-user-soul.ts`; existing persisted paths and checksum
normalization are unchanged. Check uses that helper internally only for its
remaining legacy admission and alias handling.

`grantedSoul` and `GrantInboxKind` belong to `lib/grant-delivery.ts`, alongside
the application inbox reader and writer. A delivery inbox is transport storage,
not a canonical ACL grant. New canonical records use `aclSoul`/`grantSoul`.
This extraction does not migrate wallet-keyed data or sessions to SEA identities;
that consumer migration remains tracked by #277 and #281.

## Canonical runtime primitives

`forum-key-signature.ts` and `forum-witness-json.ts` now adapt the public
`sociacl-ids` implementation instead of copying its signature and JSON parsers.
The exact qualified test tarball is recorded in `docs/sociacl-runtime.json` and
locked by npm integrity. Its manifest digest, successful source CI and GitHub
build attestation were verified before adoption. This is a build dependency;
running TEST services continue to follow their moving channel.

Compact P-256 high/low-S signatures, canonical SEA keys and duplicate-member
JSON rejection remain enforced. Cryptographic validity alone still grants no
current-key authority, session or Check permission. Remaining local recovery,
rotation, witness and authority adapters must be migrated separately; this
change does not complete #277 or #281.
