# Client-signed assignments

The browser requests an unsigned assignment plan, displays the previous and new
assignee plus every affected object, and asks the owner to confirm. After
confirmation it fetches fresh signed authority, verifies the current owner key,
recomputes the exact cancellation/grant intents, and signs with the locally
unlocked SEA pair through WebCrypto. The pair never enters an HTTP request.
Disconnect, key change, expiry or disposal cancels pending signing and drops the
connection's reference to the pair. A canceled confirmation does not write state.

The authenticated `plan` endpoint does not claim the assignment, initialize
operation stores, freeze writes, call a signer or publish records. Its immutable
result contains the exact record kind, soul and fields for each signature. The
server accepts signed material only through `start-signed`, recomputes the plan
against the requested journal revision and current authority, and verifies every
signature before claiming anything. Both request and response bodies are bounded.
The five-minute signing window does not extend a session or stale authority.

The journal CAS stores verified material with the claim, so a restart can finish
without the browser key or client resubmission. Existing prepared outboxes remain
authoritative. An authenticated retry resumes saved material; it cannot replace
those records. Cancellation predecessors and operation-bound IDs are preserved.
Group membership is checked at submission time, independently of issuance time.

The deployed pilot server has no owner signer. Unsigned `start` requests fail
before a claim; older clients must reload to use the signed flow. The optional
runtime signing callback remains for isolated fixtures and compatible library
callers, but is not configured by the pilot server. Operator provisioning signs
from private `operator.json`; generated app deployment documents contain no key.

Old moving-channel deployment documents are parsed by discarding their retired
`ownerSigningKey` field without importing it. After the keyless build deploys,
Infra's `scripts/s3rch/retire_owner_signer.py` removes the field from the TEST vault
document, refreshes the app reference and disables older key-bearing versions.
That deployment cleanup is tracked under #276; code merge alone does not prove it
has run. Production follows its separate promotion policy.

Authority completeness and inventory still depend on the provisioned service;
this custody change does not replace the authoritative Blob journal with Gun
(#279), nor does a plan alone grant authority.
