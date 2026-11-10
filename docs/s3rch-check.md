# SociACL consume contract

[s3rch-check.d.ts](s3rch-check.d.ts) is an unmodified copy of the declaration
published by [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL).
[The provenance file](sociacl-contract.json) records its source repository, full
commit and the source path, local path and SHA-256 of each artifact. SociACL owns this contract; changes belong there
first. s3r.ch runs its browser consumer without importing the Rust crate or adding
a SociACL runtime package.

## Verification

`npm test` checks the declaration and both shared vector files against their
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
expanding shared-vector coverage beyond the two families below, and replacing
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
| `vectors/ids/principal.json` | `forum-principal.test.ts`: all accepted/rejected principal inputs, canonical path keys and inverse conversions. Other authority tests reuse these identities. |
| `vectors/mesh/forums.json` | `forum-check.test.ts`: forum souls, roles, tags, permission rejection, revocation, need/offer restrictions and cancellation. Squad/authority tests reuse the same fixture. `forum-shared-hint.test.ts` checks that the upstream hint fields cannot grant access. |

These JSON files are exact upstream copies, not app-specific fixture variants.
The forum vector's SGH1 binary `hint.hex` is preserved but is not decoded by this
consumer, which currently accepts structured hints. These families do not cover
all SociACL Check, recovery, rotation or wallet-link semantics. Adding a family
requires adding its source/local mapping to the verifier and its hash to the
manifest, then running its cases against the appropriate consumer.
