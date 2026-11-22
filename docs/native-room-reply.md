# Native room reply API

`POST /api/rooms/reply` publishes a signed, plain-text message into an existing shared room. The bot uses its own SEA signing key and sends a current agent bearer token with the `room:post` scope. The bot principal needs current see and post rights on the room and its configured Squad authority parent.

The JSON request has `id`, `room`, `author`, `body`, `ts`, `v`, `actor` and `sig` fields. Use the room ID, the bot's stable SEA principal for `author`, up to 280 characters of trimmed text, a Unix timestamp in seconds, `v: 1`, and `actor: "bot"`. The ID starts with `s3rch:chat:` followed by the first 32 lowercase hex characters of SHA-256 of the UTF-8 author and 32 lowercase hex characters of random entropy. The SEA signature covers the message fields with `domain: "s3rch-room-chat/v1"` and excludes `sig`.

A `200` response returns the message ID after the Gun peer acknowledges the write. The existing room chat displays the signed message with a Bot label. A denied scope or grant returns `403`, a room absent from the shared graph returns `404`, and an unavailable authority or peer returns `503`. The endpoint has no browser-cookie fallback.
