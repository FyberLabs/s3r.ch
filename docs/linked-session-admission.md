# Signed-link session admission (#444)

`lib/identity/linked-session-admission.ts` consumes the locked `sociacl-ids`
wallet/OIDC signed-link and recovery-history contract. It is verification-only.
`createIdentitySessions` remains the sole issuer and uses the existing atomic
identity replay store. No link, rotation, key, account or enrollment is written.

A linked challenge binds the exact credential and an independent random subject.
It contains no SEA identity or link ID and performs no authority lookup before proof. It expires after 60 seconds and is bound to the issuer origin, replay domain
and browser HttpOnly challenge cookie. Wallet proof uses the existing SociACL
SIWE wire: the statement hashes the opaque challenge, the nonce is its `jti`,
and URI is the issuer origin plus `/api/identity/sea/linked-exchange`. OIDC proof
uses a pinned issuer and key resolver, exact audience, tenant claim and subject,
challenge nonce and `auth_time` no earlier than the challenge. Email and display
names are never account selectors. Multiple eligible accounts fail closed.

After credential proof, exchange resolves the link/current key and rechecks that
same selection before and after replay consumption
and rechecks credential expiry. Concurrent replay has one winner. Success issues
the same five-minute `s3rch-identity-session-v1` SEA-subject cookie as existing-key
proof. Failed admission issues no session and never creates an identity.

## Owning prerequisites and limits

Hosted routes return `503 linked-identity-unavailable` by default. No request field enables trust. The protected deployment adapter must provide the
complete credential candidate index and all authenticated current histories and
revocations through each requested instant. Its history callback must derive from
successful owning resolution; clients cannot assert a `completeThrough` value.
Up to 128 candidate rows and 1024 revocations are admitted; incomplete or larger
sources deny instead of truncating. Requests time out after five seconds.

The complete ACL credential source and protected HTTP adapter are implemented
by ACL #189 and s3r.ch #587. Deployment uses the owner-only
`S3RCH_LINKED_IDENTITY_CONFIG_FILE`; absence leaves admission unavailable.
The #440 read-only resolver and #464 local link export still cannot substitute
for complete credential authority. Auth #69 and s3r.ch #593/#594 implement the
fresh OIDC proof and browser callback path described below. Startup metadata
cookies remain insufficient.

Lost-device recovery #583 is implemented through #618: explicit encrypted
restoration, pending backup save/promotion, linked-wallet rotation authorization,
exact publication confirmation and protected local replacement are separate
actions. These source implementations do not stage credentials or establish
hosted readiness. Infra #1712 owns runtime composition; Auth #75 owns explicit
tenant transfer permission. #444 remains open for its remaining runtime and
scheduled acceptance requirements. Readers remain unregistered.

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

## Linked wallet browser controller

`createLinkedWalletClient` in `lib/identity/linked-wallet-client.ts` is a browser
controller for the linked endpoints. It asks for a challenge before invoking the
signer, so the current hosted `503` response produces no wallet prompt. It checks
the exact challenge type, origin, lifetime and wallet credential, then constructs SIWE over the challenge hash and nonce. Decoding
checks signing intent only; it does not verify the issuer MAC or establish trust.

Callers provide the selected checksummed wallet address, decimal chain ID, and
monotonic wallet/session revisions. Increase revisions for every account, chain,
connection or session change (including away-and-back changes), call `cancel()`
on those events and unmount, and pass the selected account explicitly to the
wallet signer. The controller checks selection around every await, refuses
concurrent attempts, bounds response bodies to 8 KiB, and aborts after 30 seconds.
Late signing results cannot start an exchange. Cancellation cannot undo an
exchange the server already accepted or retract an in-flight Set-Cookie response;
the owning session controller must serialize logout/account switching with session
refresh before publishing authority. After a true result, refresh the existing server session and publish identity only
if the same revisions still apply. This controller does not call
`identitySessionChanged` or provide that UI orchestration. A false result must never
update UI identity.

The controller alone does not install a button or configure trust. OIDC browser
wiring and encrypted recovery controls are separate consumers described below.
The isolated `wallet-linked-session` case bundles the wallet controller in
Chromium, first exercises an unconfigured route with zero signing calls, then
admits against a synthetic source and signer. It does not test a real wallet
extension or establish deployed readiness. Reader cases remain unregistered.

The protected HTTP adapter additionally limits native verification to 32 rotations
and revocations per account, 128 domain links and 4096 work units, with monotonic
deadline checks at account and recursive-history boundaries. Larger domains fail
closed; records are never truncated. Revocation comparison ignores JSON key order.

## Auth-owned fresh OIDC proof consumer

`linked-oidc-proof-server.ts` consumes Auth #69 from the trusted backend. Before
start, exchange, result or cancel it verifies the original SEA issuer challenge,
including its MAC, origin, replay domain and deadline. It sends the private
service bearer only to the fixed Auth origin and carries the existing terminal
binding. Provider redirect intent is checked against exact configured issuer,
client, callback, nonce, state, PKCE and fresh-login settings.

A successful provider exchange returns no token through this adapter. `finish`
reads Auth's saved proof, then calls the existing single SEA issuer for fresh
provider verification, current complete ACL resolution and atomic replay
consumption. A lost exchange response is reconciled using `result`, never by
replaying the one-time provider code. Revoked or ambiguous authority refuses.
Cancellation addresses the original attempt; it does not create another one.

The default-off browser boundary below binds the callback state and original
challenge to an encrypted HttpOnly attempt cookie and checks the current person
context on completion. No live configuration or reader case is installed by
source wiring. Encrypted lost-device recovery #583 is source-complete; its controls remain
unavailable until their protected owner configuration is supplied.

## Browser-bound OIDC completion

The existing-person device page now offers **Verify linked account for sign-in**,
**Complete linked account sign-in**, and **Cancel linked account attempt** when
`S3RCH_LINKED_OIDC_CONFIG_FILE` is configured. The existing authenticated person
supplies the exact issuer/tenant/subject; there is no email lookup or user-selected
replacement principal. The original issuer challenge and provider state are bound
in an encrypted HttpOnly, Secure, SameSite=None cookie for the form-post callback.
The callback redirects to the fixed devices page without provider code or tokens.
Same-origin completion checks the unchanged person context before and after using
Auth's saved proof. A lost provider response can be completed from that proof;
replaying the provider code is never an automatic retry. A consumed SEA challenge
cannot issue a second session. Remote cancellation uncertainty is shown separately
from clearing the local attempt. Account changes abort pending browser requests.

The absolute owner-only config file is compact recursively key-sorted JSON plus a
newline, with exact fields `version:1`, `origin`, `authOrigin`, `serviceToken`,
`issuer`, `tenant`, `clientId`, `authorizationEndpoint`, `redirectUri`. It must match
the existing device-person provider and configured linked-admission provider. The
callback is exactly `origin + /api/identity/sea/linked-oidc-callback`. The service
bearer stays in this file/server transport. Missing config leaves every new action
unavailable without outbound IO. No file or credential is staged by source wiring.

The existing terminal dispatcher continues refusing unregistered linked-login
cases; this change does not expand its inbound route allowlist or register reader
cases. Declared fixture acceptance and live configuration remain owner tasks.
