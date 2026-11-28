# Visor companion set to Squad forum binding (#551)

`POST /api/squad/pilot/visor-companion` resolves an owner- or agent-authenticated
machine's current companion set to the provisioned Squad pilot forum. Visor sends
the set identity, generation, and candidate members; the service rechecks forum
authority and returns only admitted principals plus the canonical browser
destination `https://{site}/feed/squad` without query strings or embedded
credentials.

Native machines authenticate with agent bearer scope
`squad:visor-companion:resolve`. Browser callers may use the same owner SEA
session as the live pilot page. Client-supplied rosters never grant access.

Set generation changes retire prior companion session bindings. Presenting an
older generation or a retired set ID is refused, including an empty snapshot.
Companion fencing is durable through the squad pilot tenant record store
(dedicated companion-record credentials, Postgres in
production). The service evaluates authority at server time; client `evaluatedAt`
may differ by up to 60 seconds and the response carries the server timestamp.

Consumer: hyperme-sh/visor#223 should call this endpoint for the minimized nest
icon instead of trusting per-session `companion.toml` forum URLs.