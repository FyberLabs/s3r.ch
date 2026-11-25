# Squad forum task intake and bot control

The Squad pilot can route owner intents to Plane's bot registry. Configure the
optional `plane` object inside `S3RCH_SQUAD_PILOT` with an HTTPS `origin`, a
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

The optional `project` section in `S3RCH_SQUAD_PILOT` enables one project
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
