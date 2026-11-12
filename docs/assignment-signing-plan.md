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

## Client-signed runtime submission

`startSigned(actor, operationId, replacement, revision, material)` accepts the
signed cancellations and grants for a recomputed plan. Submission permits a
five-minute signing window, but verifies the current owner key and current
membership graph. It rejects wrong targets, record kinds, revisions, times and
signatures before claiming the operation or creating outboxes. The same journal
CAS stores verified material with the claim, so a restart can finish without any
signer or client resubmission. Existing prepared outboxes remain authoritative.
An authenticated retry for the saved operation resumes its saved material; it
does not replace those records with a new request body.

The runtime signer is optional. Without one, unsigned `start` refuses before a
claim. The existing pilot HTTP/browser path still uses the legacy signer until
the client signing UI and submission route are wired and the deployment secret
is stripped of owner key material. This runtime step alone does not complete #276.
