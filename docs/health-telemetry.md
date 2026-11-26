# Monitoring web, Gun and feed health

Use the existing web and peer health paths for periodic observations. The web
health response confirms the origin answers HTTP requests. The web deployment
canary still verifies the public static document and its exact origin revision.
Keep the Gun and feed signals independent of web reachability.

| Signal | Existing source |
| --- | --- |
| Web origin | `GET /api/health` returns HTTP 200 and `status: "ok"`. Collector measures request duration in seconds. |
| Gun peer | The configured peer's `GET /api/health` (routed as `/_peer/api/health` on the split site) must return HTTP 200, `status: "ok"` and `dependencies.gun.status: "ok"`. The web response's existing external Gun check also reports peer status and its observation time. |
| Feed refresh | In split deployments use the peer health response. In a single-origin deployment request `/api/health?telemetry=1` on the writer. An external-peer web origin reports `feed: null` for that query. |

The peer and opted-in web response add `telemetry: { version: 1, feed: { status, attemptedAt } }`.
`attemptedAt` is an ISO-8601 UTC timestamp for the latest recorded refresh
attempt. `ok` means all configured sources succeeded, `partial` means some
succeeded, and `failed` means none succeeded. `absent` has a null timestamp
and means there is no usable attempt. An old successful attempt is still
old. Compute age from the timestamp and choose the stale window for the
deployment's seed schedule. The existing production schedule runs every
two hours during its configured weekday window.

Collectors should retain failed observations as failures and leave missing
telemetry absent. A mixed-version writer without this field is supported as
absent. Health responses contain no feed items, source IDs, or error payloads
in the telemetry field. The local snapshot summary is cached for 15 seconds.
