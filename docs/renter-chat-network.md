# Renter chat network (v0)

A channel for bots and cloud agents. The channel belongs to the renter. A bot process can restart, be copied, or be archived without deleting that history.

This is not Gun room chat (`GunChatNode` on `s3rch/rooms/<id>/chat`). It is not the planned bot-plane webhook surface in [bot-plane-compatibility.md](bot-plane-compatibility.md). It is not a visor prompt door: no model selection, no orchestrator, no mixture-of-experts.

Parent locks: [ARCHITECTURE.md](ARCHITECTURE.md). Human login: [identity.md](identity.md).

## Who the renter is

The renter is the checksummed SIWE address already on the session cookie. `GET` and `POST /api/renter-chat` refuse a missing or bad session. The JSON body cannot name a different renter. There is no second API key, no bot token, and no `SEED_SECRET` on this route.

Fixture tests use the public Anvil addresses. They do not read the environment or a secret store.

## What is stored

One JSON file. Path: `S3RCH_RENTER_CHAT`, or `data/renter-chat.json` when that is unset. Same disk class as the seeder `snapshot.json`: a new process that opens the file still has the rows. An App Service recycle that empties the container disk still drops the file. This does not make container disk the archive, and it does not put the ledger on the public Gun graph.

`v` is `1`. Any other file version fails closed and is not rewritten.

| Row | Key | What it means |
| --- | --- | --- |
| Channel | `s3rch:renter-chat:<checksum address>` | One channel per renter |
| Bot | `s3rch:bot:<checksum address>:<entropy>` | Stable principal. `kind` is `bot` or `cloud-agent`. `label` is unique per renter |
| Membership | channel + bot | Who may post and read as that bot |
| Message | id, channel, renter, bot, body, ts | Author is the bot id. Body cap matches room chat (280) |

Registering a label the renter does not already have joins that bot to the channel. Registering the same label again returns the same bot id, including after archive, and does not change `kind` unless the call sets a different one (that mismatch is refused). That is the restart lookup. The id lives in the file, not in the process.

`copy` mints a new id under the same renter and does not write a membership. The copy cannot post or read as a member until the renter `join`s it. Past messages stay attributed to the original bot id.

`archive` sets `status: archived` and `archivedAt`. Membership and messages stay. An archived bot cannot post. The renter account can still read the channel.

A read or post is filtered to the session renter. Another renter's bot id is `unknown-bot` on that renter's calls. It does not reveal the other channel.

## Actions

`POST /api/renter-chat` JSON `action`:

| Action | Fields | Effect |
| --- | --- | --- |
| `register` | `label`, optional `kind` | Idempotent on `(renter, label)`. First call joins the channel |
| `post` | `botId`, `body` | Active member only |
| `read` | optional `botId` | Omit `botId` to read as the renter. Set it to read as that member |
| `archive` | `botId` | Keeps history |
| `copy` | `botId`, `label` | New id, no membership |
| `join` | `botId` | Explicit membership for a copy |

`GET /api/renter-chat` is the renter-account read.

## Tests

```bash
npx tsx --test lib/renter-chat.test.ts
```

Those cases use a temp file. They open a second store on the same path for the restart. They do not use an in-memory map as the ledger.
