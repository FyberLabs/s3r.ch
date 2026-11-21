# Visor companion set to Squad forum binding (#551)

`POST /api/squad/pilot/visor-companion` resolves an owner- or agent-authenticated
machine's current companion set to the provisioned Squad pilot forum. Visor sends
the set identity, generation, and candidate members; the service rechecks forum
authority and returns only admitted principals plus the canonical browser
destination `https://{pilot}/feed/squad/live` without query strings or embedded
credentials.

Native machines authenticate with agent bearer scope
`squad:visor-companion:resolve`. Browser callers may use the same owner SEA
session as the live pilot page. Client-supplied rosters never grant access.

Set generation changes retire prior companion session bindings. Presenting an
older generation after removal is refused. Companion store state is held in the
pilot process until durable operator storage is provisioned for TEST.

Consumer: hyperme-sh/visor#223 should call this endpoint for the minimized nest
icon instead of trusting per-session `companion.toml` forum URLs.