# Plane-delivered forum updates

The Visor adapter submits a signed `update` statement and its signed ACL rows
to `/api/squad/pilot/plane/update` with its own SEA session. The request adds an
`update` object to the existing statement admission request, containing
`botId`, `assignmentId`, `sessionId`, `taskId`, `deliveryId`, `sequence`
and the signed forum statement in `signature`. Preserve the same signed
statement and sequence when reconciling a lost acknowledgment.

s3r.ch verifies the adapter's enrolled principal, current see and post grants,
the signed message's tenant, task and statement ID, and the ACL rows for that
same statement. Plane-roster signers use this admission path for forum
statements. The room path has its own authority.

The site uses the ACL source's `forum-update` operation when the pilot has a
configured Plane roster. The ACL service rechecks its fence and obtains a
durable Plane decision for the signed terminal status inside the write
transaction. Plane orders that decision against changes to the live bot
assignment and pause state. The route returns unavailable until the matching
ACL and Plane service bindings are installed.


Visor can publish terminal status with the local reporter. Run the repository's
`tsx` executable with `scripts/s3rch-visor-forum-reporter.ts /absolute/config.json`
as the Visor user. Its owner-only configuration contains `version`, `tenant`,
`botId`, `forumId`, `principal`, `owner`, `origin`, `peer`, `pairFile`,
`stateDirectory`, `readers` and the existing forum `authority` policy.
Configure Visor's `forum_reporter_socket` to the `reporter.sock` in that private
state directory. The reporter retains the signed envelope across retries and
sends it to Gun only after delivery-bound admission succeeds.
