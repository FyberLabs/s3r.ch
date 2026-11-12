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

The caller must supply a synchronous, current authorization check. Before
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
Transport cursor advancement must follow successful `receive`, and reconnection
may replay messages through the exact-duplicate path.

Remaining #31 work includes signed transport wiring, complete current authority,
bot enrollment, bounded delegation, artifact expiry/revocation, persistent stream
cursors, worker execution, and forum status/approval/cancellation UI. Unit
contracts for this component do not establish those features.
