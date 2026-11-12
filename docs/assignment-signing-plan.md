# Assignment signing plans

`createDelegationRuntime().plan(actor, operationId, replacement, revision)` prepares
unsigned cancellation and replacement grant intents from admitted authority. It
checks the owner, current assignee, unused operation ID, journal revision and fixed
evaluation second. A clock or journal change during planning rejects the result.
The caller must authenticate the actor before requesting a plan.

Planning does not claim the assignment, initialize operation stores, freeze writes,
call a signer or publish records. The immutable result contains the exact record
kind, soul and fields for each signature. Group cancellations deduplicate shared
memberships and preserve the existing deterministic operation-bound cancellation ID.
Normal runtime publication uses the same intent constructors.

This is the planning stage of #276, not the signing-key custody cutover. The existing
server signer remains in use. Browser signing and HTTP submission still need to
verify the submitted signatures against the current owner and recomputed intents
before claiming an operation, and preserve prepared bytes across recovery. A plan
alone grants no authority and must never be accepted as a signed record.
