# SociACL consume contract

[s3rch-check.d.ts](s3rch-check.d.ts) is an unmodified copy of the declaration
published by [FyberLabs/SociACL](https://github.com/FyberLabs/SociACL).
[The provenance file](sociacl-contract.json) records its source repository, full
commit, source path and SHA-256. SociACL owns this contract; changes belong there
first. s3r.ch runs its browser consumer without importing the Rust crate or adding
a SociACL runtime package.

## Verification

`npm test` checks the local bytes against the recorded SHA-256. The CI test job
also runs:

```sh
node scripts/check-sociacl-contract.mjs --upstream
```

That check downloads the declaration from the recorded immutable commit and
compares bytes. Editing both the local declaration and its hash cannot make a
modified copy pass. Unavailable upstream or a failed comparison fails the check.
The `.gitattributes` rule prevents checkout line-ending conversion from changing
the source bytes.

This is source-contract provenance, not a deployed-service version requirement.
TEST services continue to track their latest merged default branches. No service
needs to run the same revision as this declaration.

## Updating the copy

1. Select and review a full SociACL commit containing the intended contract.
2. Download `docs/s3rch-check.d.ts` from that commit and replace the local file
   without editing or reformatting it.
3. Update `revision` and the SHA-256 of those exact bytes in
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
running shared SociACL vectors against the consumer, and replacing the local
transition implementation once the upstream consume surface is available.
[#277](https://github.com/FyberLabs/s3r.ch/issues/277) owns the SEA identity migration.
[Upstream #156](https://github.com/FyberLabs/SociACL/issues/156) tracks the missing
consume surfaces and vectors needed to replace local recovery, rotation,
witness and wallet-link copies with adapters. Synchronizing this file does not
close those issues or establish live authorization acceptance.
