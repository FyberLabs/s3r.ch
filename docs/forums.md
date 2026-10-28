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

Pause and reassign on this page are puts of the status node by the forum owner. The owner named on a status id does not make that write. Check see does not make that write.

## Alarm

The alarm chip is on when a tile state is `emergency`, or when the alarm soul pins an open emergency need in the same forum. Either one is enough. The pin counts only when `pinned` is `1`, `alarm.need` is that need, severity is `emergency`, and `stated` is `1`. The alarm record is data, not a grant.

## This page

The sample roster is local. Mesh rows at the souls above replace a matching tile only when a Gun signature on that row checks out. The sample is not written out by itself. An admitted sample owner stays the owner when a mesh ACL edge names another pubkey. A grant does not replace that owner. An unsigned mesh grant is not Check see on a sample need.

The signer of a status row is the agent pubkey, when that pubkey is already on the roster, or the forum owner. The Gun map key is the agent pubkey on the signed row. A self-signed status does not add a new pubkey. Owning the status id does not admit one either: an unsigned ACL edge can name that owner. The forum owner admits one by signing that status, or by signing a role membership at `roles/<roleToken>/<seaPubkey>`. An unsigned `null` does not remove a verified status or its alarm contribution. A removal is a signed record (`removed` is 1 and `action` is `remove`) by that agent or the forum owner, bound to that forum, that status id, and that map key.

A need row is signed by the admitted owner, or by the subject when that row accepts an offer and leaves the posted body, severity, and spec in place. A close installs only when that accepted offer is a live posted offer and the helper still passes Check see. A subject-signed close is kept on a fresh load of the graph when those same gates pass, even if this browser never held the open row. An owner-signed need that arrives before ownership is loaded is kept and checked again when that owner appears. The alarm is signed by the admitted owner of the forum id. A live offer is signed by the helper and kept only when that helper passes Check see on the parent need. A live offer that arrives before that grant is loaded is kept and checked again when the grant appears. The need owner or subject may sign a cancel. A cancel (`stated` 0) is also put on `offers/<offerId>/cancel`. A later live copy at the offer key does not replace that signed cancel. A cancel that arrives before the need owner is loaded is kept and checked again when that owner appears. After a need accepts an offer, the helper cannot withdraw or remove that offer. The owner or the subject may still sign a removal. A chat line is signed by its author. The statement id names that author, so a different key cannot replace the line. A later put of that same statement id has to be that same author. A signed removal stays, and an older live copy does not return. A signed need removal drops that id from the board, including the sample row. The forum owner may hide the line and may not replace its body. An unsigned row is ignored, so a public peer cannot replace agent state, task, or result by writing a row under `agents`.

An unsigned `null` does not drop a verified need or offer. A removal is a signed record (`removed` is 1, `action` is `remove`) by the admitted owner or the subject, and for an offer also by the helper, bound to that forum, that object id, and that map key.

An unsigned `null`, a malformed put, or a tag strip does not hide a signed chat line. A retraction hides that line, including a copy kept on this browser, only when the author or the forum owner signed a tombstone (`unshared` is 1) bound to that forum and that Gun key. A signature read that finishes after a later put on the same key is ignored, so a retraction is not undone by a late read of the previous line. An id inside an unsigned tombstone does not hide a different line. A local pause or reassign stays on the tile only while its `lastUpdate` is strictly newer than the mesh row. A later mesh `lastUpdate` retires it, so an emergency after a pause shows and counts for the alarm. Reply in chat closes the drawer.

Forum writes are signed with the SEA pair unlocked on this browser. A wrapped key signs after unlock. The private half stays in page memory. It is not written back to disk or onto the mesh.

Role strips, Fleet, and Command are not on this page. `/forum` is still the desktop channel.
