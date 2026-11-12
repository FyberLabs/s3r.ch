# Room tasks and issues

The isolated fixture includes Tasks and issues; the production room panel does not mount the editor. A room reader can create a task
or issue; its creator can change the status (open, doing, done) and assignee.
Assignment is a label and grants neither room access nor editing authority.
Room Check see is required to display or submit work. The editor rechecks access,
identity, room, sharing state and the task predecessor after asynchronous
persistence. Identity or room changes discard unsent drafts and pending sends.

Work is carried by ordinary admitted v1 chat rows on the existing room timeline.
It uses the same in-memory Mine overlay and mesh publication path as chat, without a
second store or project-management shell. A task created in Mine and its updates
remain private even if the room is later shared. In a shared room its creator can
choose **Share a copy**: this publishes a new task containing only the current
title, kind, status and assignee. Private history and identifiers are not copied.
The original remains in Mine. New work created in a shared room publishes to that
room; shared work can be edited only while the room is shared.

## Chat projection

A bounded `s3rch-work:v1:` JSON-array body represents creation, status or assignment.
Creation carries kind, title, Mine/room scope, initial status and assignee. Updates
name the created chat ID and the current predecessor chat ID. Only the creator's
admitted rows can change state. Concurrent valid siblings resolve by bytewise
message ID; missing parents wait and stale branches do not overwrite the selected
history. Reloading the same rows in another order gives the same result.

`roomTasks` consumes already admitted and Check-filtered chat, not arbitrary
remote claims. It is not a signature verifier or a replacement for room/message
admission. The current chat identity contract remains in effect; the SEA-only
identity migration is tracked separately in #277.

The projection exposes `room.object.created` and `room.object.updated` for the
accepted history. A future bot-plane adapter can derive those events from its
permitted room chat stream. This change does not implement bot subscriptions or
webhooks, and does not grant bots access by assigning them work.

Titles are capped at 80 characters; the existing 280-character chat-body cap
remains. The panel shows the latest 64 tasks/issues and refuses a history above
8192 rows. Unknown work payload versions are hidden from the work timeline. Ordinary chat is unchanged.

## Checks

Unit contracts cover replay, conflicts, creator-only updates, separate rooms,
private publication, expiring room access, malformed payloads and copy sharing.
`scripts/test-room-tasks.mjs` bundles the actual editor and providers into an
isolated loopback fixture. It checks creation, status, assignment, private scope
after room sharing, explicit copy sharing, reload, access loss and draft
isolation. Its session response is a test fixture, not real login evidence.
The scenario is intended for the central scheduled nightly batch; no shared
TEST state or credentials are used.

The replay fixture retains rows to exercise deterministic reconstruction. It does
not establish production durability of the Mine overlay: private in-memory chat
work is lost on page reload, as with existing private chat. Durable private chat
requires the planned secret-store integration.

## Production admission gate

The legacy `FeedStream` subscription applies `fromGunChatNode` shape validation,
not authenticated author admission. Author and message-ID comparisons cannot
prevent same-author forgery. Production therefore does not import or mount
`RoomTasks`, hides every reserved work payload from the chat projection, and
refuses work payloads on both composition and room-copy publication paths.
The isolated fixture and projection are preparation for #152, not a shipped editor.

Enabling the editor requires verified SEA identities and signed room records
through the current forum authority contract (#277), including a regression
rejecting a forged same-author update. Check gates alone do not meet that gate.
#152 remains open until that integration and scheduled browser coverage land.
