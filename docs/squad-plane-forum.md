# Squad forum task intake and bot control

**Retired.** The `S3RCH_SQUAD_PILOT` environment variable and `/api/squad/pilot/*`
routes are removed. Forum statement admission, authority, and meeting signaling
now use `/api/squad/*` when ACL mode is configured ([configuration.md](configuration.md)). `/api/site/*` forum ACL is retired.
The sections below describe the historical pilot contract for archival reference.

The Squad pilot could route owner intents to Plane's bot registry. Configure the
optional `plane` object in the retired server-only pilot JSON with an HTTPS `origin`, a
tenant UUID in `tenant`, and a `roster` of Plane bot UUIDs mapped to SEA
principals. The server also checks current forum see and post permission for
the selected bot. The Plane configuration stays on the server.

Send a same-origin POST with the forum owner's SEA session and a separate Plane
owner bearer in `Authorization`. The SEA session remains on s3r.ch. The Plane
credential goes only to the configured origin. Both requests require version
1, `bot_id`, `source_task_id`, `assignment_id` and `session_id`.

- `/api/squad/pilot/plane/tasks` also takes either `kind: "local"`,
  `workspace` and `submission_base64`, or `kind: "remote-agent"` and
  `request_sha256`. Plane defines the UUIDv8 task identity for the exact
  Conductor request.
- `/api/squad/pilot/plane/control` takes `action: "pause"` or `"resume"` for
  the current assignment. Omit action to read confirmed run control. A resume
  still requires local Visor consent before execution.

Both routes return `taskId`, `status` and `desired` from the bound Plane
response. Retry an uncertain intake with the same source task and binding.

The optional `plane.controlCredential` in the server-only pilot configuration
enables the forum's owner controls. It is a scoped `hm_fop_` credential for
Plane's `/forum/control-current` route. The site checks the connected forum
owner and current bot grants on every list, state, pause or resume request.
The browser receives only eligible bot identifiers and confirmed run state.
The credential remains in the site's private configuration.

## Squad project tasks

The optional `project` section in that pilot configuration enabled one project
inside the configured Squad. Its map, task list and attribution history use
one private conditional record in the existing tenant record service. They
follow the current forum read and post grants. The project record credential
is server-only, and its tenant must match the Squad's Plane binding.

Create a node, select it, then create a task. The project's task ID and node
link stay stable when the node changes. The forum owner can submit an existing
staged Plane task intent from the task view. The owner uses the same Plane
authorization as the task intake route. A project request binds the intent to
the task revision and map cursor. It keeps the source-task ID and Plane task ID
on the assignment history. Reuse the exact intent after an uncertain response.
A different delegation requires a new source-task ID and a terminal previous
Plane task.

An enrolled agent with `forum:read` can resume an accepted task via
`POST /api/squad/pilot/project` with `action: "resume"`, `forum`, `taskId` and
`since` (initially 0). A worker with a Plane delivery can send `planeTaskId`
in place of `taskId`. The caller must be the currently delegated agent and still have
forum access. The response identifies the task, owner, delegate, run, branch,
and source links from the assigned revision. Send the returned cursor on the
next read. Linked URLs are references and require access at their own sources.

## Partner briefs

The existing Plane reporter can send a successful signed terminal update
to `/api/squad/pilot/plane/brief` with an extra `brief` object. Use the same
SEA session and signed ACL rows as the status route. The brief contains
`taskId` (the canonical Squad task), `artifactId`, `revisionId`, `base`
(set to null), `markdown`, and `signature`. Sign
`briefDraftTranscript` as defined in `lib/squad-brief.ts` with the current
reporter key. The signed bytes bind the Markdown digest to the accepted
delivery and target revision. The server admits the exact terminal update
first, then checks current access and saves the revision conditionally.
Each task accepts its initial draft through this route. Retry with the same revision ID and signed content after an uncertain reply.

From the Squad task, open the brief, select a revision, edit the current
revision, or export the selected Markdown. Comments and review decisions
are tied to one revision and can point to an inclusive range of lines.
The task's source references remain linked on its draft and revisions.

## Partner pricing workbook

A successful delivered run can supply an initial pricing workbook at
`/api/squad/pilot/plane/workbook`. Attach `workbook` with `taskId`,
`artifactId`, `revisionId`, `inputs`, and `signature` to the existing
signed terminal update. The inputs are `quantity`, `unitPriceCents`,
and `discountBps`. Sign `workbookDraftTranscript` with the current
reporter key. Exact retries preserve later owner revisions.

The Pricing sheet contains quantity in B2, USD unit price in B3, the
discount in B4, and a formula-driven quote total in B5. From the Squad
task, edit the current assumptions, open a specific revision, attach
a comment to a cell or range, or download XLSX for the selected revision.
The download keeps numeric inputs and the quote formula editable in a
spreadsheet application.

## Private partner preview

Send a successful signed terminal update to
`/api/squad/pilot/plane/preview` with a `preview` object. It includes the
`taskId`, `artifactId`, `revisionId`, `base`, `briefRevisionId`,
`workbookRevisionId`, `copy`, and `signature`. Set the first base to null.
For a later preview, use its current revision as the base and a new
delivered partner task run. The copy contains a title, summary, up to four
highlights, and a next step. Sign `previewDraftTranscript` with the
current reporter key.

The site renders the copy as text in a fixed HTML document and computes its
quote from Pricing B5 in the selected workbook revision. The task shows
the source revisions, pricing inputs, authors, and whether a newer input
is available. Open or download a specific preview revision under the
current Squad grants. The embedded preview runs in a sandbox with scripts,
network requests, and form submission disabled.

## Publish through the local Visor reporter

Send one newline-terminated JSON request to the existing private reporter
socket. Keep the connection open for the response. For an artifact, send
`{"version":1,"report":{...},"artifact":{"kind":"brief","draft":{...}}}`.
The `report` is the existing terminal status object, with the Plane task and
delivery IDs and status `completed`. Set `kind` to `brief`, `workbook`, or
`preview`. Pass the corresponding draft above without its signature. The
draft's task ID is the canonical Squad project task ID.

On success the reporter returns one JSON line containing `version`, `taskId`,
`artifactId`, and `revisionId`. A status-only request still receives `ok`.
The reporter keeps the signing key private and reuses its terminal proof
across artifact requests for the same delivery. On an interrupted reply, send
the same draft for that delivery and kind. The reporter reuses the saved
signature and Squad checks current authority before acknowledging the revision.
