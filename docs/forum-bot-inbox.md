# Private bot dispatch inbox

`lib/forum-bot-inbox.ts` prepares the durable client bookkeeping for Visor #31.
It is a Node 24 Unix library, not a public route, React server action, forum
principal enrollment service or running bot worker. Nothing imports it into the
production forum yet. Gun remains the shared record; the private SQLite file
only tracks which authorized task references this bot has already accepted.

A database binds exactly one tenant, forum, registered bot and independent
principal. Put it in a directory owned by the bot user with mode `0700`; the
library creates a `0600` database and refuses shared files or final-component
symlinks. Keep the path outside workspace attachments and mounted shares. SQLite
transactions serialize claims across connections. Full synchronous commits
happen before a claimed reference is returned. This uses the existing Node
runtime's [SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html),
without a new npm dependency.

The caller must supply a synchronous, current authorization check. It receives
the immutable database scope and must return literal `true`; promises and other
truthy values are refused. Before
receive, it must validate the signed statement, independent bot enrollment,
tenant/forum binding, current sender and recipient access, and any delegation
chain. Before dispatch it must recheck those permissions, local consent and the
authorized task handle. A remembered signature or old grant is insufficient.
The inbox does not implement those proofs or turn a forum post into permission.

Task records contain IDs, sender, an opaque authorized handle and a deadline,
never raw files, secret values, arbitrary URLs or executable task text. IDs and
message IDs are independently unique. An exact duplicate is acknowledged;
conflicting content is rejected. The receive deadline is at most one hour and is
checked again after dispatch authorization. Cancellation here covers pending
work only; active cancellation belongs to the bounded Visor task executor.

Claims are never automatically retried. A new worker sees an unfinished prior
claim as `unknown` and cannot finish or reclaim it. A crash after commit and
before execution can therefore leave an uncertain task requiring owner action.
Terminal state is not proof of successful external work; the worker must obtain
that result before recording it. The executor must still enforce consent and
authorization throughout execution.

The default capacity is 4096 retained task IDs, configurable up to 16384. A full
inbox refuses new tasks instead of discarding its replay protection. Do not
remove or rotate the database while the same message stream can be replayed.
An optional opaque transport checkpoint can be committed atomically with
`receive(task, {before, after})`. Its compare-and-swap prevents a stale worker
from advancing another worker's cursor. `cursor()` survives reconnects; exact
retries of an already committed task/checkpoint are idempotent. The transport
must authenticate and scope its cursor, then supply every message through this
path. A checkpoint is not itself an access grant. A denied or conflicting task
never advances it.

## Signed channel admission

`openForumBotChannel` wraps the inbox with real SEA verification and the current
`ForumAuthorityGraph`. Provision each tenant/thread with independently enrolled
bot UUIDs and SEA principals, the thread owner, allowed human root senders, and
a local delegation ceiling (zero by default, at most four). Bots cannot mint
root tasks. Every hop requires current thread read and post grants for its sender and
recipient, statement read/post authority for the author, statement read authority
for the receiving bot, a current signing key, a nonextended deadline, an exact parent task,
and no repeated bot or task. The caller supplies complete signed chains, not
claims about ancestor authorization. A persisted context digest prevents a
changed ancestor from being substituted after restart.

Ordinary signed forum statements carry `visor:v1:` followed by a compact JSON
array, bounded by the forum's 280-character body limit:

- `task`: tenant UUID, task UUID, recipient bot UUID, authorized task handle UUID,
  expiry in Unix seconds, parent task UUID or null, delegation depth limit.
- `ack` and `cancel`: tenant UUID and task UUID.
- `progress`: tenant UUID, task UUID and integer percent from 0 to 100.
- `result`: tenant UUID, task UUID, terminal state and artifact UUID or null.

Statement IDs bind the signing principal and provide message identity; task IDs
correlate replies. These records carry no executable instructions or private file
contents. Task handles are reauthorized on receipt and claim through the required
synchronous `handleAllowed` callback. Local consent is required on claim. Current
authority must be refreshed for the current second using complete trusted history;
stale or missing authority fails closed. Old owner-impersonating forum JWTs are
not accepted by this channel.

`event` verifies a correlated signed status or cancellation after its task chain
has been admitted. Only the assigned bot can report status. The root user or
immediate task issuer can cancel pending work. It returns `cancelled: false` for
active or unknown work; it does not report that running work stopped. Remote
status is informational and cannot finish a local claim. Status consumers must
deduplicate/order signed message IDs and timestamps. Artifact references require
a separate current access/expiry/revocation check before retrieval. Replaying the
original signed task chain restores proof availability after restart without
reclaiming uncertain work.

The forum chat renders these statements as task cards under the existing signed
author attribution. Progress and results remain reports, not executor state. A
task author can prepare a cancellation when the composer is empty, inspect its
preview, and send it through the existing signed publishing path. Artifact
references are plain text and are never fetched by the card. These controls do
not grant task execution or artifact access.

Remaining #31 work includes deployed enrollment and complete-authority wiring,
Gun subscription/checkpoint wiring, worker execution and active cancellation,
authorized artifact retrieval, and execution-backed approval/status controls. The
signed-channel unit contracts do not establish those deployment features.
