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

The following sections describe subsequent registry-client, forwarding, outbox
and route-composition slices. Controller authentication, whole-fixture route
classification and installed owner acceptance still gate installation. No capability
can be advertised from token hooks alone. #552 remains open.

The bounded `terminal-run-client.ts` implements the agreed Auth registry HTTP
protocol with a service-specific HMAC key, strict configured immutable fixture
scope, original-run receipt checks and no cached verification. Its construction
is per request. It refuses missing/duplicate grants and unsupported native identity
kinds. The adapter is TEST-only and uninstalled; it does not add a controller route,
fixture configuration, schema, credentials or activation. HTTP/HMAC contracts run
only in CI with named in-process transport substitution; the Auth owner supplies
actual PostgreSQL and transaction-race evidence independently.

The alternate-credential follow-on also binds startup PKCE/linked metadata,
backup OAuth PKCE/age/session, wallet nonce and confirmation tokens. Verified
provider tokens must carry the same original run before they can be wrapped into
new local credentials. Startup broker subjects remain separate from SEA keys.
Native fixture tests run in CI only. Unsupported wallet/backup credential kinds
remain denied by the installed-adapter candidate; these hooks do not authorize
an alternate fixture identity mapping or enable those paths.

Protected experiment outboxes now persist the original admitted run and generation
on the consent ledger, including its revocation tombstone. Missing, foreign and
successor contexts cannot adopt or drain it. Unrelated ledgers keep the v1 shape;
older readers refuse the additional protected field rather than treating it as
unrelated traffic. Existing pre-seal admissions may finish the awaited sink send
and conditional progress commit; only then may the request completion predicate
acknowledge them. Ambiguous sends retain pending admissions. This remains source
composition only: no reader registration, route installation or activation.

The device relay forwards only the grant captured by the admitted request, through
`X-Nightly-Run-Grant`, to the exact Auth TEST relay path. Auth independently admits
that grant and checks the pending operation within its native relay transaction.
No browser Cookie header or client-selected grant header crosses this boundary.
The s3r.ch helper refuses foreign targets and closed request continuations.

The subsequent ACL forwarding slice below covers device `state` and `current`.
Their native commit/verifier enforcement remains with the shared authorization
owner. The current source does not install a controller endpoint, read new
deployment credentials, register reader cases, or advertise a capability.

Auth registry and relay service requests use `https://api.test.hyperme.sh`;
the provider issuer remains `https://auth.test.hyperme.sh/realms/controlplane`.
These distinct service and provider origins must not be interchanged.

ACL forwarding consumes the checked-in owner contract from ACL #187: only POST
`/api/v1/acl/sociacl/device-transfer/state` and `/current` on
`https://api.test.hyperme.sh` receive the original admitted grant. Existing bearer,
tenant, origin and device-context checks remain required. The native ACL worker
must independently verify the admitted subject, tenant and source/destination
origins. This forwarding source does not install that worker or the s3r.ch wrapper.

`createTerminalDeviceRoute` is an explicit, uninstalled composition of the actual
device handler and authenticated per-request registry client. It checks the native
TEST tenant, provider/client and fixed Auth/ACL targets before construction. Each
request passes normalized ingress and exact method/path checks before admission.
Confirmed authorization/callback redirects require the native nonempty credential
cookie; failed redirects and unknown outcomes retain pending admission. A lost
completion or seal withholds the response and its newly issued cookies. CI covers
the native encrypted-PKCE handler with a named registry transport substitution.

No app route imports this factory. Whole-fixture route classification (including
unrelated users and startup alternatives), controller composition and integrated
owner acceptance remain required before installation; the factory alone is not a capability.

`createTerminalSeaRoute` prepares the actual SEA issuer and existing Squad session
alias behind per-request admission, with the declared fixture SEA allowlist and
explicitly configured Spanopticon replay namespace. The replay product tenant is
independent of either run scope identity tenant. It refuses linked-login paths until their
complete owner source exists. The real browser client accepts only the exact
optional run/generation hint shape in its signing intent; it does not treat that
decoded hint as authenticated authority. Native CI exercises sign-in, old-run
replay, seal and an accepted replay consume whose response is lost. An uncertain
exchange retains pending admission. This factory remains uninstalled as well.

`createTerminalExperimentRoute` composes the actual consent/display/outbox
application with registry admission and explicit transport injection. Successful
telemetry delivery waits through its outbox commit; ambiguous receipt and an
unverified withdrawal retain pending admission. Completion failure withholds the
response cookies. Native CI substitutes registry, storage and Azure transports
while exercising real signing and application code. This factory is uninstalled;
its close operation only closes its local provider and is not terminal evidence.

The private prepared deployment contract is decoded by `parseTerminalOwnerConfig`
from an explicitly supplied `S3RCH_NIGHTLY_RUN_CONFIG` JSON string. It requires
both s3r.ch suite scopes, exact TEST origins, separate controller/owner keys, and
a declared non-pilot SEA identity for device transfer. Duplicate members and
unknown fields refuse. This decoder does not read process environment, install
`/api/internal/nightly-run`, register grants or provide readiness evidence.
The control handler and complete route inventory remain separate work.

`createTerminalOwnerControl` prepares the authenticated POST control handler for
`/api/internal/nightly-run`. It verifies the controller HMAC over bounded exact
bytes, validates the owner/action/run/scope, and re-signs those same bytes with
the separate owner key for Auth. Auth owns monotonic fences, pending operations
and durable tombstones. The handler refuses fences outside JavaScript safe integer
range rather than rounding them, and validates exact positive phase receipts.
Native HTTP/HMAC contracts run in CI with Auth transport substituted. This factory
is uninstalled, performs no retries, and neither installs configuration nor proves
whole-fixture coverage. Reader cases remain unregistered.

`createTerminalStartupRoute` prepares the actual startup availability, PKCE start,
OAuth callback and credential reader behind admission. It requires the configured
TEST provider, client, tenant and SEA key to match the declared experiment scope.
The native Auth identity reader forwards the original admitted grant only to
GET `https://api.test.hyperme.sh/auth/startup/identity`; Auth #68 and Edge #74 own
its independent native admission. Lost callbacks/identity responses retain pending
work and failed completion withholds cookies. This wrapper does not fall back to
backup OAuth. It remains uninstalled; complete identity classification and the
owner contract merges remain required before installation.

`createTerminalFixturePolicy` is an explicit, uninstalled native identity guard
independent of browser grant presence. Configured SEA/OIDC subjects cannot mint
or verify ordinary unbound credentials under that guard. Admitted credentials
still require original run and owner authorization. Unrelated identities and
anonymous precursors retain legacy behavior, but a precursor cannot replace the
subsequent verified fixture-subject check. The policy snapshots scope, refuses
nested replacement and closes inherited async contexts on exit. Native SEA CI
proves old fixture credentials fail while unrelated credentials still verify.
No route dispatcher installs this guard yet; the complete route inventory must
enclose every native fixture issuer/verifier before deployment activation.

## Prepared serving dispatcher and route inventory

`createTerminalServingRouter` composes the native factories under the fixture
policy for the whole request. It is not imported by app routes or installed.

| Native request | Configured TEST behavior |
| --- | --- |
| Device authorize/callback/config/logout/relay/state/current | Require grant; exact device suite and native handler. |
| SEA session/challenge/exchange/logout and Squad session alias | A single registry admission accepts either exact configured suite. Without a grant, the native handler is enclosed by fixture policy and cannot accept the configured fixture subject. |
| Startup availability/start/session and shared OAuth callback | Require grant; only the native startup handler, never backup OAuth fallback. |
| Experiments GET and POST, including consent replacement and withdrawal | Require grant, including anonymous requests. This scoped TEST restriction prevents unattributed fixture outbox mutation. |
| Identity session, backup-session view and provider list GET | With a grant, native read runs under admission; a known 401 is a completed read. Without it, fixture policy remains active. |
| Identity logout POST | Native cookie clearing under admission when a grant is present; not terminal proof. Same-origin required for the admitted path. |
| Other identity paths, including wallet verification, linking, confirmation and delegation | Refuse under configured TEST router, with or without a grant; no guessed wallet alias policy. |
| Other API paths carrying a grant | Refuse before native effects; do not silently fall back. |
| Pages and static/feed-cache assets | Native rendering remains enclosed by fixture policy. Current `/`, `/feed` and `/identity/devices` render client identity components and do not verify server cookies. |

The current wallet-only session route returns `owner: ""`; only a verified SEA
session produces a mesh owner. Native dispatcher CI exercises that actual route,
old unbound fixture replay, unrelated SEA access, both SEA suites with exactly one
admission per request, and absent-grant consent/withdrawal preserving an existing
native outbox. Auth, replay and storage transports are named substitutes; page
rendering is substituted. Startup positive native contracts are separate in the
startup factory suite. CI is not installed or scheduled acceptance.

Installation still requires the whole application handler/renderer to enter this
dispatcher and the prepared private owner configuration. Selectively installing
only grant-bearing API routes is unsafe. No setting is read automatically, no
capability is published, and reader cases remain unregistered.

Replay namespace correction: the dispatcher CI uses distinct flags identity, device
identity and replay product tenants. Native challenges bind the fixed replay
namespace while registry admission checks the exact original identity scope; no
identity tenant or browser input selects storage credentials.

The experiment product-record tenant is likewise independent of the flags identity
tenant. Native configuration validates it and binds privacy tokens, records and
cache/runtime namespaces; request bodies cannot override it. CI uses a fourth
distinct product-record tenant, refuses a caller tenant field without changing
the outbox, and retains original-run/successor refusal coverage.

### Default-off Next entry integration

The Next route entrypoints now call the dispatcher when private
`S3RCH_NIGHTLY_RUN_CONFIG` is present. With the setting absent, native handlers
remain in use. Malformed or changed process configuration refuses requests; a
failed dispatcher initialization never falls back. The proxy only rejects
unsupported paths and invalid ingress. It does not establish authority through
headers or assume shared context with route workers.

Native token readers independently classify configured fixture identities, even
outside wrapped handlers and when the grant cookie is absent. Compiled route
bundles share process-local AsyncLocalStorage instances by stable symbols;
authority and native callbacks remain request-local. Different workers each
require their own authenticated admission. Read-only container health without
cookies remains available on localhost. The existing pages render identity on
the client through guarded API routes; future server identity reads inherit the
native token guard rather than trusted forwarding headers.

The build job launches the actual standalone Next server with synthetic owner
transports. It covers absent/malformed configuration, old fixture credential
refusal, unrelated identities, unsupported mutations, concurrent admitted SEA
suites across route bundles, auxiliary session reads and removal of grants.
These are isolated CI contracts, not deployed acceptance. No configuration,
credentials, capabilities, reader registrations or live activation are installed
by this source change. Scheduled owner acceptance remains required for #552.
