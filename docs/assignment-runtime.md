# Durable Squad assignment and access

`createDelegationRuntime` connects the signed recovery components to one
conditional journal. `SquadDelegationControls` uses the explicitly supplied
`ForumAuthoritySource.assignments` client. There is no default service endpoint
or synthetic identity in the application. The public Squad remains a demo;
production provisioning and deployed acceptance remain #190.

## Mutation and authority boundaries

The server derives the Squad namespace and actor from its authenticated session,
not request fields. It verifies current signed forum ownership and complete
history before accepting owner commands. The immutable owner cannot be the assignee;
owner access is not revocable by assignment. Destinations must have independently
verified ownership. `runtime.admit` registers destination ownership/ACL evidence
and inventory together, using the expected journal revision. Every authoritative
ACL writer, destination registration, drawer child write, and assignment change
must participate in the same journal. An arbitrary Gun write is not journal
admission. A separate cache or browser mutex is insufficient.

The journal stores the current assignee, all registered destinations, signed ACL
rows, current operation, child records, and completion receipts. Its compare-and-
swap boundary serializes these changes. A claimed operation blocks ordinary
registration and child writes. Stale sessions cannot publish after cancellation
or after another client advances the journal. The existing object IDs, owners,
and Gun paths do not change.

For each operation, the runtime freezes a separate complete inventory, prepares
an immutable exact signed cancellation batch, and binds its digest into the
journal. It cancels direct post and see for each destination, plus the prior
assignee's relevant group membership. Group cancellation requires that group's
owner key; an external group owner or any surviving independent access path
leaves the operation incomplete. Membership cancellation can affect other uses
of that same membership; provisioning must choose groups with that intended
scope. It never substitutes an Elect or changes object ownership.

The publisher verifies the candidate cancellations, publishes the saved bytes,
and reconciles durable evidence. Only then does it prepare fresh direct see/post
grants for the replacement. Those grants are immutable and digest-bound too.
The current planner grants a 24-hour window from preparation; retries never
extend it. Expired plans remain incomplete and require operator recovery rather
than silent re-signing. Direct negative rows remain negative after that window;
expiry does not resurrect superseded positive grants.

Before the first replacement publication, the journal enters the replacement
phase. Abort is allowed only before that phase and never restores cancellations.
After replacement begins, retry must finish the saved operation. A completion
receipt is committed only after the actual durable snapshot proves both old
access absent and new access effective. Saved receipts replay for the authenticated
owner even after later assignments,
destination registration, or grant expiry; a mismatched replacement is refused.
Receipts record an evaluation time, not perpetual access. Every subsequent read/write still checks fresh authority.

A lost acknowledgement, process restart, or partial batch resumes the same
operation and bytes. Missing prepared inventory or signed documents fails
closed; it is not an invitation to create a new operation or signature. Used
operation IDs and receipts are retained. Capacity is explicit: 64 destinations/
children, 256 operations, 1024 ACL rows, and a 2 MiB journal. Claim reserves row
capacity for two direct cancellations, one effective group cancellation and two
new grants per destination. Destination and row-capacity failures occur before
claim; byte/retention limits also fail closed rather than dropping historical
revocations. Long-lived compaction must preserve authenticated evidence.

The server-side history provider is independently trusted and complete. Its
rotation/revocation updates must be serialized with this authority sink, or the
sink must reject stale history generations. A claimed `completeThrough` from an
untrusted peer is not sufficient. Retired-key cancellations still require the
existing witnessed evidence checks; missing witnesses cannot be bypassed by
retrying or by re-signing a saved batch.

## Storage and consumer wiring

`createBlobAssignmentJournalStore` provides the primary-container CAS adapter at
`s3rch-assignment-journal/v1/<server-derived-namespace>.json`, separate from the
inventory and immutable outbox slots. It reads bounded body+ETag snapshots,
creates only if absent, and replaces only the exact ETag. Authentication/container
provisioning remains the operator's responsibility; no new production environment
variables are introduced.

A provisioned source supplies `assignments` alongside its verified authority
snapshots. Controls load the server operation after reload, retry that operation,
and display pending/failure rather than treating a status edit as success.
Completion responses must match the requested operation and replacement.
Drawer writes pass their real SEA-signed record through the authoritative child
sink before the existing Gun mirror; the sink verifies current key, scope,
registered destination, see/post and artifact-target access, then CAS-writes.
Before choosing the next revision, the drawer recovers the committed child from
the authenticated journal. Lost responses cannot strand a write between the
journal and Gun. Recovered revisions are conflict floors only; recovered content
still passes SEA verification and current ACL checks before display or mirroring.
Unknown child IDs must first go through authenticated destination admission;
metadata alone cannot create ownership or grants. Pending assignment blocks that
admission. Direct Gun writes cannot add destinations to this source.

## Isolated synthetic Squad acceptance

Run on Node 24+ after `npm ci`:

```sh
node scripts/test-assignment-acceptance.mjs
bash scripts/test-delegation-blob.sh
```

The first command provisions fresh random owner and three synthetic agent keys,
private credentials and a durable SQLite journal in its own temporary directory.
Its server binds only to loopback. Independent authenticated HTTP clients perform
real P-256 ACL verification and real SEA child signing. It injects a lost grant
acknowledgement, restarts the server process, compares retained signed bytes,
finishes from another client, checks revoked and replacement reads/writes, races
assignments, registers a child, and verifies abort retains cancellations. It cleans
up its own directory. `KEEP_ASSIGNMENT_TEST_STATE=1` is a test-only debugging
option to retain that private directory. Missing credentials or a missing live
journal on restart refuses reset.

For browser checks, explicitly run:

```sh
node --import tsx scripts/squad-acceptance-server.ts /tmp/my-private-test-squad 4388
```

Open the printed loopback URL in separate browser profiles. Read the generated
owner token locally from the private directory's `credentials.json` and enter it
in the password field. Never paste the token or private keys into a PR or chat.
The page mounts the actual assignment controls and lists synthetic agent public
keys. Its fault-injection/signing endpoints are test-only, never application
routes. Stop the process when finished. The server is not a deployable production
identity provider.

| #188 acceptance | Evidence |
| --- | --- |
| Durable operation, complete inventory, serialized mutations | Journal CAS and runtime tests; independent Blob clients with stale ETags and emulator restart |
| Signed direct and group cancellation, destination ownership | Runtime group test plus reconciliation authority/independent-path tests |
| Lost responses, partial writes, retired keys | Runtime write-failure/lost-ack matrix; reconciliation witnessed/retired-key tests |
| Durable access before completion | Real authenticated HTTP read/post checks and SEA child writes; immutable receipt replay |
| Restart, concurrency, new child, abort, stale retry | Process-restart acceptance; journal session and registration races; partial replacement abort refusal |
| Fresh grants, unchanged owners/paths | Two consecutive runtime assignments and real-client owner/path assertions |
| Controls and child consumers | Two-browser assignment/pending/retry checks; response binding; drawer sink fencing tests |

The CI test job runs the synthetic multi-client acceptance. The separate storage
job exercises Azurite. These results establish isolated consumer/runtime behavior;
they do not establish live Azure, production witness configuration, or the deployed
Squad pilot. #190 still requires production source provisioning, configuration
ownership, history fencing, deployment, and the full deployed multi-client matrix.
