# Opt-in forum bot worker

`npm run forum-bot -- /absolute/private/config.json` runs one independently
authenticated bot on Node 24 Linux. It does not start from the web server or an
install hook. Unit contracts exercise its boundaries; deployment requires the
trusted source described below and scheduled integration qualification.

The configuration file and SEA key/token files must be owned by the worker user
with mode `0600`. Approval and state directories must already exist with mode
`0700`, outside shares and attachments. Configuration has exactly these fields:

```json
{
  "version": 1,
  "scope": {"tenant": "TENANT_UUID", "forum": "THREAD_ID", "bot": "BOT_UUID", "principal": "BOT_SEA_PUBLIC_KEY"},
  "owner": "THREAD_OWNER_SEA_PUBLIC_KEY",
  "bots": {"BOT_UUID": "BOT_SEA_PUBLIC_KEY"},
  "rootSenders": ["AUTHORIZED_HUMAN_SEA_PUBLIC_KEY"],
  "maxDelegationDepth": 0,
  "authority": {"keys": [], "pinnedIssuers": [], "policy": "PROVISIONED_AUTHORITY_POLICY"},
  "origin": "https://your-forum.example",
  "authorityEndpoint": "/api/squad/pilot/authority",
  "statementEndpoint": "/api/squad/pilot/statement",
  "peer": "https://your-gun-peer.example/gun",
  "approvalsDirectory": "/absolute/private/approvals",
  "stateDirectory": "/absolute/private/state",
  "pairFile": "/absolute/private/bot-sea-pair.json",
  "visorOrigin": "http://127.0.0.1:9847",
  "visorTokenFile": "/absolute/private/visor-token"
}
```

This is a schema illustration, not enrollment material. Supply actual authority
configuration from the deployment, independently enrolled principal mappings and
current thread grants. The key file holds the bot's own SEA pair. The worker
obtains its own short-lived SEA session; it never uses a human browser cookie or
wallet-owner token. Every authority refresh requires complete primary history.
Gun is transport, not a completeness authority.

The server can inject a `BotStatementSource` into `createSquadPilotServer` or
`createSquadHttpServices`. Its `read` returns primary history plus an opaque
concurrency fence. Its `append` must atomically compare every history/ACL input,
invoke the supplied expiry/abort guard immediately before commit, and retain all
accepted signed rows. It must not reconstruct completeness from Gun or a legacy
assignment journal. `/api/squad/pilot/statement` returns unavailable without this
provider; authenticated readiness is checked before the worker starts. General
source provisioning remains part of s3r.ch #279. No production provider is
silently installed by this change.

## Local approval and execution

Before a task can execute, its opaque handle must name an owner-authored
`HANDLE_UUID.json` in the approval directory:

```json
{
  "version": 1,
  "tenant": "TENANT_UUID", "forum": "THREAD_ID", "bot": "BOT_UUID",
  "principal": "BOT_SEA_PUBLIC_KEY", "handle": "HANDLE_UUID",
  "session": "CURRENT_VISOR_SESSION_UUID", "expires": 1800000000,
  "revoked": false,
  "task": {"steps": [{"tool": "view", "arguments": {}}]},
  "artifactReaders": ["AUTHORIZED_READER_SEA_PUBLIC_KEY"]
}
```

Use a real future Unix deadline. Visor validates each closed tool's arguments.
The file is read again at admission and dispatch and while work runs. Delete it,
set `revoked` to true, or change its contents to cancel active work. Session
consent must already be running: the worker never starts or resumes automation.
Requests use Visor's `/session/{id}/tasks/leased` endpoint with the current resume
sequence and an absolute lease of at most 14 seconds. Queue time consumes the
lease. Visor also fences session replacement and pause/resume changes.

Claims commit before submission. An uncertain submission or interrupted worker
is never retried automatically. Preserve the private inbox, outbox and cancelled
root records across restarts; deleting them discards replay protection. Root
cancellation also blocks later descendants. Only currently authorized individual
statement objects are subscribed to; there is no global feed scan. Gun replay
restores chains while the durable inbox deduplicates execution. Its checkpoint
is an opaque last accepted statement ID, not an ordered Gun offset.

Local approval reports, acknowledgments, progress and results first enter the private durable outbox.
After a successful submission, the bot reports the task ID, approval time,
and deadline. It never republishes the private approval handle, approved tool
arguments, or reader list to report readers.
This is a historical report by the bot; neither it nor the forum card can grant
execution permission. The private approval and live session consent still control
each dispatch and cancellation.
Each report keeps one stable statement ID and signed node across retries. The
bot admits only its own signed statement authority and currently eligible reader
grants, then publishes the exact node. Missing authority or admission stops
publication. Neither reports nor task cards can mark an executor claim complete.

## Private artifacts

Successful results may be stored locally only when the approval names readers.
Forum posts contain an opaque UUID, never bytes, a bearer URL or a file path.
Retrieval requires a fresh SEA signature by an approved reader, current reader
and bot thread access, the original reader list, and the still-current local
approval. Expiry, revocation or loss of current key authority denies access.

A private request file contains `principal`, `issuedAt` and `signature`; sign this
exact object with that reader's current SEA key:

```json
{"version":1,"operation":"read-artifact","tenant":"TENANT_UUID","forum":"THREAD_ID","bot":"BOT_UUID","artifact":"ARTIFACT_UUID","nonce":"FRESH_UUID","issuedAt":1800000000}
```

Use the same actual Unix timestamp outside and inside the signature, at most 30
seconds old. Run `npm run --silent forum-bot -- /absolute/private/config.json
artifact /absolute/private/request.json` with stdout redirected to a private
file. This mode does not start Gun or execute tasks. Artifact reads are separately
authorized; they are not delegated access to `/api/media`, a vault or an owner
wallet. The forum card deliberately does not fetch these handles.

The primary source append is also bounded by the authority reader contract:
at most 1024 retained signed rows and a 4 MiB complete response. The source
fence must cover the retained total; concurrent growth must lose the comparison.
Each enrolled principal receives an equal share of a 512-row/2-MiB statement
budget, capped at 128 rows and 256 KiB. Retained statement ACL rows count too,
including expired grants. Exhausting one principal's allocation returns 507;
other principals keep their shares. The remainder is reserved for identity and
thread history. This bounded worker does not prune signed history automatically.
Canonical signed retries are idempotent: retained rows and duplicates within
one request consume no additional slots. Supplied signatures are still checked.
An admission of new rows that would exceed these limits returns 507 without appending.

Client capacity is bounded: 4096 retained reports, 256 artifacts of at most 1 MiB each,
and 512 authorized statement subscriptions. Capacity exhaustion refuses work;
there is no automatic replay-floor eviction. Remove artifact bytes explicitly
when no longer needed, while preserving inbox/outbox replay records.
