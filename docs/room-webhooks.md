# Room webhooks

A shared room owner can send an authenticated JSON request to
`POST /api/rooms/webhooks/subscriptions` with `action`, `room`, and, for
`subscribe`, the receiving bot's SEA principal in `bot`. The owner can use
`list` or `remove` with the returned subscription ID. Creating a subscription
requires the bot to have current room and parent forum see rights.

The callback path is `/api/rooms/webhooks/receive`. TEST sends only to
`https://test.s3r.ch` and production sends only to `https://s3r.ch`. The receiver
checks the exact JSON bytes with HMAC-SHA256 and records the delivery
idempotently. It accepts matching queued events only. A bot reads delivered
events with `GET /api/rooms/webhooks/inbox?subscription=<id>` and a current
agent bearer scoped to `room:webhook:read`.

Shared, signed room activity emits `room.message.created`,
`room.object.created`, or `room.object.updated`. Deliveries contain an event
ID, the room ID, and the message or work object event. The worker checks
current room visibility and recipient access at delivery. A failed delivery
gets up to two retries. The queue deduplicates event IDs per subscription.

The integration requires the server-only `S3RCH_ROOM_WEBHOOK_SIGNING_KEY` and
the dedicated `S3RCH_ROOM_WEBHOOK_RECORD_ORIGIN`,
`S3RCH_ROOM_WEBHOOK_RECORD_TENANT_ID`, and `S3RCH_ROOM_WEBHOOK_RECORD_API_KEY`
settings. The tenant must match the statement-source tenant.
