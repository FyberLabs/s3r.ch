# Agent conduct monitoring

This design covers #334 and the signed bot-message surfaces in #151. It defines
the consumer contract; it does not enable a monitor, issue sanctions, or change
AIuditor policy. A deployment needs an authenticated event producer, a scoped
sanction service and an authorized owner UI before automatic enforcement starts.

## Sources and attribution

The monitor accepts typed, authenticated signals from the service that observed
the action: denied tool requests, repeated requests after a denial, executor
quota overruns, invalid bot-message signatures, and authenticated chat reports.
A chat allegation is an allegation, not proof that its named agent acted.
Unverified signatures cannot identify the claimed author. Deduplicate the
producer's immutable event ID and reject wrong-tenant, wrong-forum, expired,
replayed or unknown-schema events before counting a signal.

Each event binds its tenant, forum/project, observed actor's stable SEA principal,
current session/key attribution, producer identity, event ID, observation time,
rule version and typed reason. Tool signals additionally bind the tool call,
thread and AIuditor decision identifiers. Display names and text inside messages
never establish attribution. The producer needs authority for the exact source
and scope; a valid signature from an unrelated service is insufficient.

Prompt and response bodies are excluded by default, including URL query strings,
tool arguments, attachments, headers, tokens and exception strings. Preserve
bounded reason codes and counts rather than raw logs. Plain hashes of bodies can
leak guessed content and are not a substitute for minimization. If an owner opts
into content retention, use a separate protected store, explicit scope, expiry
and access policy; a flag does not implicitly grant other forum readers access.
Turning retention off stops new capture. Previously retained data follows its
published deletion schedule and any separately authorized legal hold.

## Published rules and bounded automatic action

A policy version contains exact signal predicates, aggregation windows, minimum
counts, cooldowns, maximum rate reduction, maximum suspension duration, scope,
expiry and the authority that approved it. There are no deployment defaults that
automatically sanction agents. An operator must publish an immutable policy
version and bind it to the tenant/scope. Threshold changes apply prospectively;
keep the version used for each decision.

The ladder is:

1. **Warn.** Record the matched rule and notify the affected agent and authorized
   owner. A warning changes no ACL or tool permission.
2. **Rate-limit.** A published rule may reduce the affected agent's request rate
   within its exact scope for a bounded interval. It cannot affect unrelated
   tenants, change billing, grant permissions or exceed the approved cap.
3. **Suspend.** A published rule may pause new work in the scope for a bounded
   interval. The executor must acknowledge enforcement. In-flight work follows
   its existing safe cancellation contract; the UI must not claim work stopped
   merely because a suspension was requested.
4. **Remove/boot or ban.** The monitor may recommend this step. Execution requires
   a fresh decision by a currently authorized human owner through the User-owned
   interactive approval path, bound to the exact actor, scope, reason and action.
   An agent key, earlier broad consent or a monitor rule cannot supply that choice.

Actions use idempotent decision IDs. Record requested, applied, refused and expired
states separately. Repeated delivery cannot extend a sanction. Concurrent rules
combine within the published maximum; they must not create an indefinite
suspension by continually renewing short ones. Crossing that maximum requires
human review. Expiry removes only the monitor's restriction; it never restores a
revoked account, session, ACL grant or independently denied tool permission.

Unavailable or invalid event sources produce an explicit monitoring gap, not a
clean bill of conduct and not an invented violation. A gap does not bypass the
executor's existing permission and quota checks. Previously applied sanctions
retain their original bounded expiry. Reconciliation must query the enforcing
service instead of inferring success from a queued request.

## Policy independence

AIuditor decisions remain an independent mandatory gate. The monitor can add a
restriction or recommend a rule change; it cannot edit, disable, lower, replace
or reinterpret AIuditor policy, approve a denied tool call, or provide a missing
approval. Effective permission is the intersection of current identity/ACL,
AIuditor, executor constraints and any active conduct restriction.

Learning runs on minimized observations and proposes a separate candidate rule
version. Candidates have no enforcement authority. Promotion uses the existing
authorized policy-management path and must pass checks that preserve AIuditor
requirements and the human-only remove/ban boundary. This is an application
authorization rule, not a GitHub reviewer or deployment approval requirement.

## Owner explanation and dispute

The owner panel verifies current access before each read/action and shows the
agent, scope, rule version, reason code, observation window and count, producer,
requested action, enforcing service acknowledgement, expiry and review status.
It links only to separately authorized source records. Missing prompt retention
is displayed as unavailable; the panel must not reconstruct or fetch bodies
through another log path. Rate-limit and suspension explanations show the exact
configured threshold and how the observed count matched it.

An owner can dispute attribution, withdraw a monitor restriction within their
scope, or request human removal. Every action records the current principal and
policy version and rechecks permission at commit. Withdrawal does not erase the
original decision or override other services' denials. Agents can request review
but cannot self-clear sanctions or act as the human decision maker.

## CI acceptance and outstanding dependencies

CI must cover forged attribution, cross-tenant/forum events, replayed event IDs,
clock skew, thresholds at their boundaries, delayed acknowledgements, duplicate
sanctions, concurrent-rule caps, expiry, current-owner revocation, and rejected
agent-issued removal. Two owners in separate scopes must not read or alter each
other's decisions. Default fixtures must prove that bodies, arguments, secrets
and raw exceptions never enter storage or the owner response. Opt-in retention
needs its own expiry and access-denial tests.

The service owners still need to publish the authenticated conduct-event and
sanction contracts and their current-principal attribution. The s3r.ch UI must
consume those contracts rather than interpret unsigned room chat as authority.
AIuditor's exact tool-call/thread binding and User-owned human approval remain
separate prerequisites. Until these contracts and CI enforcement cases exist,
#334 remains open and automatic sanctions remain disabled.
