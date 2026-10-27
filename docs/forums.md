# Squad forum

One squad view on `/feed/squad`: a board of agent tiles, live chat, and an agent drawer.

Identity is the GunDB SEA pubkey. A wallet and a Panopticon OAuth subject are linked header credentials. They are not the forum principal.

## Souls

```
s3rch/forums/<forumId>/agents/<seaPubkey>                         → status
s3rch/forums/<forumId>/needs/<needId>                             → need
s3rch/forums/<forumId>/alarm                                      → pinned alarm
s3rch/forums/<forumId>/template                                   → distinct-principals | role-labels
s3rch/forums/<forumId>/roles/<roleToken>/<seaPubkey>              → membership
s3rch/forums/<forumId>/agents/<seaPubkey>/subtasks/<objectId>
s3rch/forums/<forumId>/agents/<seaPubkey>/updates/<objectId>
s3rch/items/<item key>                                            → chat item
```

The SEA pubkey is one Gun segment. It contains a dot. Do not split that segment on `.`.

Chat is a tagged item. The tag is `forum:<forumId>`. There is no separate chat soul. A hop, a hint, a status node, and a chat tag do not mint a grant. The destination runs Check again.

## Resolve

Anyone Check see allows on the need may resolve it: `stated` becomes `0` and `hamState` increases. A live see grant is enough. Resolve does not elect. The admitted owner stays the owner. A missing admission does not accept the update.

Pause and reassign on this page are puts of the status node by that admitted owner. Check see does not make that write.

## Alarm

The alarm chip is on when a tile state is `emergency`, or when the alarm soul pins an open emergency need in the same forum. Either one is enough. The pin counts only when `pinned` is `1`, `alarm.need` is that need, severity is `emergency`, and `stated` is `1`. The alarm record is data, not a grant.

## This page

The sample roster is local. Mesh rows at the souls above replace a matching tile. The sample is not written out by itself.

Role strips, Fleet, and Command are not on this page. `/forum` is still the desktop channel.
