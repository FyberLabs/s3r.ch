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

The route returns unavailable until a provider implementing
`PlaneForumUpdateAuthority` is supplied. The provider must commit the signed
statement and its ACL rows while the ACL fence and current Plane delivery
binding both hold. It must refuse pause, revocation and conflicting reuse of a
delivery sequence, and handle identical retries without adding a second
statement. Reading Plane before an ordinary ACL append leaves a pause race.
The current ACL provider exposes only an ACL fence, so provisioning cannot
enable this route with configuration alone.

Visor can publish terminal status with the local reporter. Run the repository's
`tsx` executable with `scripts/s3rch-visor-forum-reporter.ts /absolute/config.json`
as the Visor user. Its owner-only configuration contains `version`, `tenant`,
`botId`, `forumId`, `principal`, `owner`, `origin`, `peer`, `pairFile`,
`stateDirectory`, `readers` and the existing forum `authority` policy.
Configure Visor's `forum_reporter_socket` to the `reporter.sock` in that private
state directory. The reporter retains the signed envelope across retries and
sends it to Gun only after delivery-bound admission succeeds.
