# Room games

Open a shared room in `/feed`, then use **Start game** beside Live chat. Another
signed-in reader joins as O; the starter is X. Players take turns selecting an
empty square. The board shows the result and supports starting another game.
The selector keeps the eight most recent sessions in view. Room presence marks
players here or away without changing their seat or permissions.

The session object is its starting chat message. Join and move objects use the
existing room chat path and are admitted/published through the same chat flow.
Each action names its session and preceding action. A client rebuilds the board
from those objects, validates turns and empty cells, and ignores stale moves or
moves after a result. Missing predecessors wait for delivery; concurrent valid
siblings are ordered by message ID so arrival order does not select a winner.
Ordinary chat displays readable game notices.

Starting, joining and moving require current room `see` access, checked again
before publication if local persistence was awaited. Games do not mint grants,
share a Mine-only room, or change a presence heartbeat into authority. The shared
board has the same authorship trust and peer availability as the current room
chat transport. No adjudicator, hosted game store or durable transcript is added.
Peer availability can delay delivery; an offline peer's old board is not proof
that the other player has received a move. Existing chat retention determines
whether a later client can reconstruct a session.

`lib/room-game.test.ts` covers complete games, draws, winning lines, replay after
reload, concurrent arrival order, missing parents, stale/invalid moves, room
separation, malformed events, message bounds and room-grant expiry. Full browser
and peer checks belong to the nightly CI batch.
