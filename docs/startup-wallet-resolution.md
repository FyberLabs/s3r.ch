# Startup wallet resolution boundary

`createStartupWalletResolver` is a read-only verification primitive for #440 and
Infra #1261. It does not enroll, generate keys, read private keys or wrap envelopes,
publish local links, or activate services. No live source is configured.

Deployment code must inject `StartupWalletSource.read(wallet, at, signal)` backed
by an independently authenticated **complete wallet candidate index**, including
all relevant raw histories and revocations. Return `null` if coverage or freshness
cannot be established. Source identity and coverage policy must be configured
independently of returned evidence. Neither an arbitrary peer's `completeThrough`
value nor an owner-scoped ACL snapshot proves wallet-wide completeness.

The historical local export in PR #464 is useful evidence of one wallet signature.
It does not prove current history, revocations or completeness across devices and
cannot be adapted directly into this source. The resolver and export are separate
preparatory pieces. #440 remains incomplete until an owning authoritative source
or public-proof export with equivalent provenance and the Infra consumer/nightly
scenario are implemented. Do not substitute an invented completeness flag.

The caller configures witness keys, SIWE policy and pinned OIDC issuers independently
of evidence. Pass a checksummed wallet and a bounded abort signal. Time is Unix
seconds. Success returns only `binding: { wallet, principal, sea_public_key,
evaluated_at }`: `principal` identifies the genesis account and `sea_public_key`
is its verified current key. The binding is valid only at its evaluation instant,
not a durable authorization capability. Stage from a fresh result; never fall
back to an earlier binding after refusal. Keep records private and activation off.

Every eligible account is counted, regardless of link recency. Multiple links to
one account deduplicate. Zero or multiple accounts refuse. Revoked/unretained
links cannot select an account. Forged evidence, missing history, stale reads and
source errors return fixed reason codes without proof or source-error details.

Unit/contract tests use synthetic proofs. They do not establish live source
readiness. The future registered Infra nightly must exercise authenticated source
coverage and refusal propagation through the staging consumer; shared-host checks
must not be run manually.
