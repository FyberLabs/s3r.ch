# Bot plane compatibility (Slack/Discord-shaped, not clones)

2026-09-22. **Planned v1.** Draft for Product review — not signed off, and not implemented. No routes, tokens, or webhooks ship with this note.

Parent locks: [ARCHITECTURE.md](ARCHITECTURE.md). Remaining work: [ROADMAP-v1.md](ROADMAP-v1.md). Grants: [s3rch-check.md](s3rch-check.md). Human sessions: [identity.md](identity.md).

## Why

Humans already coordinate in Discord (groups) and Slack (work). AI attaches to those products through events, webhooks, and a REST write. s3r.ch should ease both in by speaking those shapes.

Rooms already exist as Gun threads with live chat and presence. Check see-grants decide who can see a room. Mine-until-share still holds. Gun is the graph. Azure App Service stays a seed peer and bootstrap, not a chat server. Panopticon stays the open service plane for TURN, oracles, and payments. This note does not add a second control plane.

## Bet

An adapter-compatible bot plane sits beside the human Gun mesh. Humans keep the existing room UI. Bots are first-class actors, not accounts dressed up as people. A human session still binds to a SIWE address. A bot does not borrow that cookie.

The record stays the Gun room. A webhook is a notification of a put the bot is allowed to see. A missed delivery does not delete the message and does not grant `see`. If a write cannot be admitted onto the same chat path a human uses, it fails. It does not queue in Azure as the product.

Gun nodes stay `v: 1`. The bot edge is one documented event surface aligned with that version. It is not a REST versioning matrix and not a central social API host (steering lock 3).

## Primitives

| Familiar shape | On s3r.ch |
| --- | --- |
| Room ≈ channel | Existing Gun room (`GunRoomNode`). ACL is Check `see` on the room, not a permission bitfield |
| Message | Existing `GunChatNode` on `s3rch/rooms/<id>/chat` |
| Thread | Planned. A structured thread under a room message. Live chat today is a flat Gun map |
| Reaction | Planned. An annotation on a message, on the same event bus |
| Bot identity + scoped token | A bot principal and a token scoped to rooms. Distinct from a SIWE session |
| Inbound events | Room activity the bot can already see |
| Outbound write | Admit, then put a message the bot is allowed to send |
| Webhook subscription | An operator-registered HTTPS callback for those events |

Threads, reactions, tokens, and webhooks are the target shape. They are not on the live room UI.

## P0 target

Chris Hamilton’s lean, for Product to accept or amend: a **neutral OpenAPI event + write surface**, documented as s3r.ch-native, plus **thin adapters** that remap to Slack Events / Incoming Webhooks and Discord interactions enough that Bolt, n8n, and Cursor-style bots can attach without a custom s3r.ch SDK on day one.

Day-one native events and writes:

| Planned native name | What it is |
| --- | --- |
| `room.message.created` | A chat message was admitted on a room the subscriber can see |
| `POST` reply | A message write onto that room’s chat path |
| Webhook delivery | HTTPS POST of the event to a registered URL |

Planned remap (shapes only):

| Native | Slack-shaped | Discord-shaped |
| --- | --- | --- |
| `room.message.created` | Events API `event_callback` with `event.type = message`. A subset, not the Events catalog | A webhook JSON body a generic client can read. Not a Gateway opcode |
| `POST` reply | Incoming Webhook `{"text":…}` or a `chat.postMessage`-shaped `{"channel","text"}` | Webhook execute `{"content":…}`, or an interaction callback body |
| Subscribe | Events request URL | Interactions endpoint URL (type-1 ping included) or the same generic webhook URL |

Discord interactions cover commands and component callbacks. They do not carry a passive transcript. A bot that needs every room message uses the native webhook. It does not open a Gateway.

Out of P0: the full Discord Gateway (opcodes, intents, gateway presence), the full Slack Bolt surface, and a permission-bitfield clone.

## Auth

Bot tokens are distinct from human SIWE sessions. The bot principal is the accessor Check names. Seeing a room still requires `CHECK(see, room, accessor)` at now. Registering a webhook does not mint a grant, and a webhook body is not a grant. Sending still admits before `put`, the same rule as human chat.

A bot token does not announce a `GunPresenceNode` and does not wear a human display name.

Bot tokens and webhook signing secrets stay off the public Gun graph, off `NEXT_PUBLIC_*`, and out of the browser bundle. Same rule as SIWE secrets, SEA `priv` / `epriv`, and TURN secrets.

## Project management (v1 light)

Typed objects live in the room: issue, task, status, assignee. They emit the same bus (`room.object.created`, `room.object.updated` — names planned with the message event). Humans get that Linear-lite view inside the room they already have. Agents use the webhook and the REST write. There is no second app, and the human UI is not a Linear, Jira, Discord, or Slack clone.

Mine-until-share still holds. A write into a Mine-only room stays on the overlay until that room node is shared. Sharing a room still does not publish every Mine post inside it.

## Non-goals

- A hosted chat server that replaces Gun.
- A pixel clone of the Discord or Slack UI.
- Auto-mirroring a private Slack or Discord workspace into the mesh.
- Inventing Check grants from webhook payloads or adapter callbacks.
- Growing Azure App Service into the bot runtime or the transcript store.
- A control plane beside Panopticon.

## Success criteria

One hello-world bot can:

1. Subscribe to `room.message.created` on a room it can already see.
2. `POST` a reply through the write surface.
3. Receive the event on its webhook.

A human sees that reply in the existing room UI. There is no separate project-management product.

Until those three steps work against Gun, this file stays a draft.
