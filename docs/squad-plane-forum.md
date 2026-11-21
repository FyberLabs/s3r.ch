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
  `request_sha256`. Plane defines the UUIDv5 task identity for the exact
  Conductor request.
- `/api/squad/pilot/plane/control` takes `action: "pause"` or `"resume"` for
  the current assignment. Omit action to read confirmed run control. A resume
  still requires local Visor consent before execution.

Both routes return `taskId`, `status` and `desired` from the bound Plane
response. Retry an uncertain intake with the same source task and binding.
