# Signed-link session admission (#444)

`lib/identity/linked-session-admission.ts` consumes the locked `sociacl-ids`
wallet/OIDC signed-link and recovery-history contract. It is verification-only.
`createIdentitySessions` remains the sole issuer and uses the existing atomic
identity replay store. No link, rotation, key, account or enrollment is written.

A linked challenge names the exact credential, signed-link ID and current SEA
key. It expires after 60 seconds and is bound to the issuer origin, replay domain
and browser HttpOnly challenge cookie. Wallet proof uses the existing SociACL
SIWE wire: the statement hashes the opaque challenge, the nonce is its `jti`,
and URI is the issuer origin plus `/api/identity/sea/linked-exchange`. OIDC proof
uses a pinned issuer and key resolver, exact audience, tenant claim and subject,
challenge nonce and `auth_time` no earlier than the challenge. Email and display
names are never account selectors. Multiple eligible accounts fail closed.

Exchange re-resolves the same link/current key before and after replay consumption
and rechecks credential expiry. Concurrent replay has one winner. Success issues
the same five-minute `s3rch-identity-session-v1` SEA-subject cookie as existing-key
proof. Failed admission issues no session and never creates an identity.

## Owning prerequisites and limits

Hosted routes return `503 linked-identity-unavailable` by default. No environment
flag or request field enables trust. A deployment-code adapter must provide the
complete credential candidate index and all authenticated current histories and
revocations through each requested instant. Its history callback must derive from
successful owning resolution; clients cannot assert a `completeThrough` value.
Up to 128 candidate rows and 1024 revocations are admitted; incomplete or larger
sources deny instead of truncating. Requests time out after five seconds.

No such hosted source is currently installed. The #440 read-only resolver and
#464 local link export do not prove global completeness. OIDC additionally needs
an owning fresh-login flow supplying the challenge nonce, configured client and
exact tenant claim. Startup metadata cookies are not signed-link proofs. Browser
integration with real wallets/Keycloak, actual source deployment, and any lost-key
recovery remain outstanding; #444 must stay open for them.

This is login to a resolved existing identity, not reconstruction of a private
key. Lost-key recovery needs the shared recovery policy and authenticated rotation
publication contract. No new key or implicit merge is an acceptable fallback.
Issued sessions prove recent authentication; object access still requires Check.

## Isolated scheduled browser scenario

Command: `npx tsx scripts/test-linked-session-browser.ts`, only in scheduled CI.
Setup launches Chromium and a fresh context per case. All requests to the fixture
origin are intercepted in-process; unexpected origins are refused. The production
HTTP handlers and issuer run against these **named substitutions**:

- Synthetic signed wallet/OIDC links and a complete single-account, unrotated
  history supplied by `scripts/fixtures/linked-session.ts`.
- Synthetic wallet signer and pinned OIDC signing key, replacing real providers.
- In-memory atomic replay map, replacing the deployed tenant replay store.

Readiness is a successful browser challenge with the HttpOnly cookie. Cases are
`wallet-linked-session`, `oidc-linked-session`, `replayed-proof-refused`,
`revoked-link-refused`, `stale-source-refused`, and `missing-source-refused`.
The runner writes sanitized per-case JUnit to `TEST_EVIDENCE_DIR/linked-session.xml`
through the shared nightly case-results helper, for Infra ingestion into
`results.json`. It also emits only case names, statuses and fixed refusal reasons. It never
prints proofs, cookies, credential values or signed records. Every context and
browser closes in `finally`; no shared service or persistent fixture is mutated.
The isolated result does not establish hosted identity readiness. The existing
startup linked-login scenario still covers the separate metadata/existing-key UI.
