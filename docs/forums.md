# Squad forum

One squad view on `/feed/squad`: a board of agent tiles, live chat, and an agent drawer.

Identity is the GunDB SEA pubkey. A wallet and a Panopticon OAuth subject are linked header credentials. They are not the forum principal.

## Souls

```
s3rch/forums/<forumId>/agents/<seaPubkey>                         → status
s3rch/forums/<forumId>/needs/<needId>                             → need
s3rch/forums/<forumId>/needs/<needId>/offers/<offerId>            → offer, owned by the helper
s3rch/forums/<forumId>/alarm                                      → pinned alarm
s3rch/forums/<forumId>/template                                   → distinct-principals | role-labels
s3rch/forums/<forumId>/roles/<roleToken>/<seaPubkey>              → membership
s3rch/forums/<forumId>/agents/<seaPubkey>/subtasks/<objectId>
s3rch/forums/<forumId>/agents/<seaPubkey>/updates/<objectId>
s3rch/items/<item key>                                            → chat item
```

The SEA pubkey is one Gun segment. It contains a dot. Do not split that segment on `.`.

Chat is a tagged item. The tag is `forum:<forumId>`. There is no separate chat soul. A hop, a hint, a status node, and a chat tag do not mint a grant. The destination runs Check again.

## Offers

Anyone Check see allows on the need may post a live offer (`stated` 1). That does not set the need to `stated` 0. The offer soul is `s3rch/forums/<forumId>/needs/<needId>/offers/<offerId>`. The offer id is kind `offer`, and the embedded principal is the helper SEA pubkey. The helper owns the row and may withdraw it (`stated` 0) until the need is resolved on that offer.

The need owner or the subject accepts one live offer only when the graph holds the offer that helper posted and that helper still passes Check see. A caller-supplied offer that was never posted is refused. When the subject is the helper, that principal may accept their own offer. Accept sets `stated` to `0` and `accepted_offer`. Decline sets that offer to `stated` 0 and leaves the need open. Reopen is the owner only. It sets `stated` to `1`, clears `accepted_offer`, and keeps earlier offers. Accept does not elect. The admitted owner of the need stays the owner.

This page puts those four rows with a Gun signature from the writer. It does not put an unsigned stand-in. `body` and `severity` stay as posted. `spec` is an optional object id and stays as posted. A resolved need refuses withdrawal of the offer it names.

Pause and reassign on this page are puts of the status node by that admitted owner. Check see does not make that write.

## Alarm

The alarm chip is on when a tile state is `emergency`, or when the alarm soul pins an open emergency need in the same forum. Either one is enough. The pin counts only when `pinned` is `1`, `alarm.need` is that need, severity is `emergency`, and `stated` is `1`. The alarm record is data, not a grant.

## This page

The sample roster is local. Mesh rows at the souls above replace a matching tile only when a Gun signature on that row checks out. The sample is not written out by itself.

The signer of a status row is the agent pubkey or the admitted owner of that status id, and the Gun map key is the agent pubkey. A need row is signed by the admitted owner, or by the subject when that row accepts an offer and leaves the posted body, severity, and spec in place. The alarm is signed by the admitted owner of the forum id. An offer is signed by the helper, or by the need owner or subject when they cancel it. A chat line is signed by its author. An unsigned row is ignored, so a public peer cannot replace agent state, task, or result by writing a row under `agents`.

A chat put that is `null`, a tombstone, or no longer tagged `forum:<forumId>` drops that line, including a copy kept on this browser, only when the Gun key is that line. An id inside an unsigned tombstone does not hide a different line. A local pause or reassign stays on the tile only while its `lastUpdate` is strictly newer than the mesh row. A later mesh `lastUpdate` retires it, so an emergency after a pause shows and counts for the alarm. Reply in chat closes the drawer.

Role strips, Fleet, and Command are not on this page. `/forum` is still the desktop channel.
