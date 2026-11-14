# Inline tool approval

This design implements the boundaries for #335's same-thread approval surface.
It does not turn the existing bot approval report into an execution capability.
The report in `docs/forum-bot-inbox.md` describes a bot's local decision; the
interactive flow here requires AIuditor and the User-owned approval service.

## One proposal, one thread, one decision

A proposed call has immutable tenant, forum/project, prompt-thread ID, call ID,
requesting stable SEA principal, executor/session, tool name/version, normalized
argument digest, expiry and AIuditor policy/decision version. The approval
request must be issued by the trusted execution/approval service after policy
checks. A bot chat message, URL, button payload or claimed approver is not a
request from that service.

The card appears in the same authorized thread as the prompt and proposal. Its
preview shows the tool, bounded description of the operation, affected resources,
requesting agent, expiry, policy reason and requested decision scope. Sensitive
arguments are fetched only through a protected preview API when needed to make
an informed decision; they are never copied into public chat or generic logs.
A digest binds exact arguments but does not replace an understandable preview.
If the preview cannot be obtained or cannot be safely understood, approval stays
unavailable. The service must reject ambiguous or noncanonical argument encodings.

An edited tool, argument, destination, executor, thread, policy requirement or
identity creates a new proposal and invalidates the old approval. Neither a
successful earlier call nor a previous card in the thread approves the new call.
Duplicate delivery of a card or decision cannot create another execution.

## Current approver authority

Approve and Deny invoke the User-owned interactive approval route. The route
requires a fresh authenticated human decision, resolves its current key to the
stable SEA principal, and checks AIuditor RBAC and exact thread/tenant scope at
commit. A wallet or Keycloak display identity is not the authorizing principal.
An agent session cannot impersonate this interactive human route. A valid SEA
signature alone is insufficient when the current policy requires a different
approver or revoked that principal's role.

The signed/attested decision records the proposal ID and digest, exact scope,
approver principal, action, policy version, issued time, expiry and a one-use
execution binding. A denied decision creates no execution capability. The
browser stores no reusable approval key and cannot self-certify the decision.
A shared forum read grant does not imply the right to approve its tools.

## Executor gate and state

Display pending, approved, denied, expired, revoked, executing and completed
states separately. A requested approval is pending until the trusted service
confirms it. A card disappearing, a timeout, an unavailable approval service or
a malformed response never means approval. A failed delivery remains retryable
under the same idempotent request ID without guessing whether it committed.

Immediately before execution, the executor verifies current identity, ACL,
AIuditor policy, required approver authority, proposal binding, expiry, revocation
and one-use consumption. Consume authorization atomically with the execution
claim. A second worker, replayed message or retry cannot run the call twice.
The service must reconcile an uncertain execution outcome before any retry that
could repeat a side effect. Cancellation does not falsely claim an already
executing action was undone; its actual outcome remains visible.

A forum statement, memory block, tool output or agent report cannot override an
AIuditor denial. Effective permission is the intersection of all current gates.
If policy becomes stricter after approval, the old decision cannot satisfy the
new requirement. Approval state is private service state; Gun chat is a display
transport at most, never its authority or completion source.

## Standing grants

A standing grant is an explicit AIuditor RBAC rule with a bounded actor, tools,
resources, tenant/scope, constraints and expiry. The authorized owner UI lists
its effective scope, issuer, current state and revocation action. Creating one
must use the existing current-policy management contract, not a checkbox on an
unrelated single-call card.

The executor evaluates a standing grant against the current call and current
policy. A tighter per-thread requirement still requires inline approval. A
revoked, expired or narrower grant never falls back to a broader cached grant.
Revocation affects future execution claims; the UI must distinguish that from
canceling work that already began. The agent cannot modify its own standing
grant or infer it from earlier successful calls.

## Browser and privacy behavior

Keep cards bound to their mounted thread and authenticated session generation.
On logout, key/tenant/thread change or revoked read access, abort pending reads,
clear protected previews and invalidate actions. Late responses cannot populate
a different thread or reactivate an old card. Before an action, retrieve the
current proposal and decision version; server checks remain authoritative.

Show a compact reason and the SEA-attributed decision to authorized readers,
without exposing private arguments, tokens or unrelated resource names. Keep
prompt bodies out of default logging. The product's declared retention schedule
applies to proposals and decisions; this design does not authorize indefinite
content retention. Native notifications should link to the protected thread
rather than carry sensitive previews.

## CI acceptance and dependencies

CI needs a trusted producer/executor fixture plus two current human principals
and an agent. Cover same-thread display, forbidden cross-thread/tenant proposals,
wrong/currently revoked approvers, argument and policy changes, expired decisions,
agent attempts at human approval, standing-grant revocation, tighter thread rules,
concurrent consumers, duplicate cards and uncertain execution results. Assert no
execution for pending, denied, unavailable, expired or revoked approval. Browser
contracts must cover logout/thread-change races and private-preview clearing.

AIuditor #87 still needs exact tool-call/thread/policy binding and current SEA
attribution; the User service owns interactive approval resolution. Until those
contracts are available and exercised together, #335 remains open. Existing bot
status cards and local operator approvals must retain their current limited
meaning and cannot be presented as this completed workflow.
