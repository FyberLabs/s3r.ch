# Serving session terminal recovery (#552)

Status: native token hooks implemented; no runtime capability is installed or advertised.
The Keycloak provider extension in Infra #1651 does not invalidate tokens signed
by s3r.ch. Provider deletion, cookie clearing, expiry and browser shutdown are not
serving terminal proofs. Reader cases remain unregistered.

## Issuance and verification boundaries

| Path | Current commit / external effect | Verifier and remaining terminal work |
| --- | --- | --- |
| SEA challenge/exchange, linked login, agent delegation | `identity/sea-session.ts` consumes the challenge through Spanopticon replay, then signs a JWT. Replay consumption and token issuance are separate operations. | `sea-session-verifier.ts`, linked/agent claim readers, `sea-request-session.ts`, site/Squad/experiment callers must consult the original run's durable state. Cryptographic validity alone cannot admit a terminal run. |
| Squad sessions | `squad-http-services.ts` uses the same SEA issuer, with separate Squad authority reads. | Preserve the SEA run binding through the shared issuer; a Squad grant does not replace the serving barrier. |
| Device authorize/callback | `device-person.ts` signs encrypted PKCE state, exchanges an OAuth code, then wraps the provider access token in a person cookie. A lost callback can follow a successful provider mutation. | Both pending/person decryptors must validate run attribution. Provider exchange must retain pending work on uncertainty; provider terminal evidence is independent. |
| Device relay/state/current | `device-server.ts` forwards to Auth or ACL after reading the person cookie. | Forward authenticated original scope to the actual owning commit boundary. A before/after local read cannot fence a delayed remote mutation. |
| Device logout | `device-server.ts` clears two browser cookies only. | Clearing cookies does not retire server tokens or remote effects. A terminal operation must remain separate. |
| Wallet identity and OAuth alternatives | `identity/session.ts` signs wallet JWTs; `identity/age.ts` issues them. OAuth/startup handlers also issue their own metadata credentials. | Inventory these alternate routes for declared fixture identities so an ordinary credential cannot bypass run admission. Preserve unrelated users. |
| Experiment consent/display | `experiment-privacy.ts` signs consent/display tokens; `experiment-application.ts` may erase an earlier outbox before issuing a replacement. | Consent and display tokens need trusted original scope, independent of current browser cookies. Anonymous consent needs controller attribution before mutation, not a later guessed subject. |
| Experiment outbox/delivery | `experiment-outbox.ts` conditionally updates a tenant record and sends to independent sinks. Accepted telemetry is retained. | Pending sends need original attribution and an owning commit barrier; do not equate local cancellation or outbox erasure with remote rollback. |

## Required owner composition

The controller registers immutable original run, attempt, suite, generation,
tenant/org, issuer/realm and declared client/fixture scope before dispatch. Current
recovery-holder authentication is separate and may advance without changing that
original scope. Neither a child-selected header nor an ordinary fixture credential
can establish attribution. Registration and token verification must survive restart;
terminal records must not expire merely because browser credentials have expired.

The serving admission/terminal serialization boundary must live in the tenant's
owning durable authority, with PostgreSQL for new state. No local database, Blob
ledger, in-memory fallback or s3r.ch-owned storage credential bypass is introduced.
A token committed before sealing must be included in exact-run retirement; a token
or delayed write after sealing must not become usable. Unknown state refuses.
A stale verifier cache cannot reopen a terminal run.

The provider/controller owner is defining authenticated downstream registration,
propagation and verification. The serving implementation must consume that concrete
contract, including failure/acknowledgement semantics, before enabling any route.
A generic optional callback alone is not an implementation of terminal recovery.

## CI acceptance

Use the actual issuer, handlers and durable authority adapter to cover admission
versus seal, accepted-but-lost response, retry, delayed work, restart, old credential
replay, stale holder, foreign scope and preservation of unrelated state. Name every
mock transport/provider boundary. Unit tests and coverage may run locally; signing,
HTTP, persistence, native-provider and browser contracts run only in CI. Installed
composition and hosted acceptance remain separate from source merge.

## Implemented first slice

`identity/terminal-run.ts` scopes an injected trusted admission to one asynchronous
request. The actual SEA/linked/agent issuer, SEA verifier, device pending/person
JWE, wallet session and experiment consent/display signing/verification paths bind
`nightly_run: {run,generation}`. A bound credential fails outside the admitted
context; missing or different binding fails within it. Native identity policy is
an explicit adapter decision, not an equality between SEA keys and OIDC subjects.
Concurrent requests do not share context; detached continuations cannot mint after
completion. Confirmed native work can drain its pending admission even if sealing
raced it, while the response authority remains refused. Exceptions and unconfirmed
results never complete an admission.

Pure mock unit coverage covers these transitions. Native signing contracts use the
real production token code in PR CI only; they substitute the registry and SEA
fixture identities. This is not PostgreSQL, provider, HTTP-adapter or hosted proof.

Outstanding before installation: the Auth-owned PostgreSQL registry/client,
controller authentication, configured fixture policy, route wrappers, complete
OAuth/startup/nonce/confirmation alternative-path coverage, Auth relay propagation,
and experiment outbox commit composition. No capability can be advertised from
these hooks alone. #552 remains open.

The bounded `terminal-run-client.ts` implements the agreed Auth registry HTTP
protocol with a service-specific HMAC key, strict configured immutable fixture
scope, original-run receipt checks and no cached verification. Its construction
is per request. It refuses missing/duplicate grants and unsupported native identity
kinds. The adapter is TEST-only and uninstalled; it does not add a controller route,
fixture configuration, schema, credentials or activation. HTTP/HMAC contracts run
only in CI with named in-process transport substitution; the Auth owner supplies
actual PostgreSQL and transaction-race evidence independently.
