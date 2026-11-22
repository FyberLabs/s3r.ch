# Squad remote-agent CLI and MCP

The client submits an owner-admitted operation through Conductor's private
remote-agent ingress. Plane must already have the enrolled remote client,
current grant and Visor-delivered task. The client uses the original bytes
from an owner-only operation file.

Create an owner-only JSON configuration file with `version: 1`, `origin`
(the private Conductor HTTPS origin), `tenant`, `bot`, `credentialFile` and
`operationsDirectory`. Use absolute paths. The credential file holds the
enrolled `hm_rag_` credential. Store each exact operation as
`OPERATION_UUID.json` in the private operations directory.

- CLI: `npm run squad-agent -- /absolute/config.json submit OPERATION_UUID`
- MCP: run the repository's `tsx` executable with
  `scripts/s3rch-squad-agent.ts /absolute/config.json mcp` over stdio.
  Use `submit_admitted_operation` with the operation UUID.

The output is the observed Conductor response. If a response is lost or
refused, check Plane before admitting new work. Forum publication goes
through the Visor adapter.
