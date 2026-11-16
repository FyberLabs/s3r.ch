# Forum Memory map

The Memory map tab combines the business ledger with linked photo/video
collections. It is a collection view, not a geographic map: no coordinates,
capture dates or other location metadata are inferred.

A forum member with post permission can link a group from their current Granted
page. The explicit action publishes its label and set/predicate reference through
the existing signed forum statement path. The canonical body is
`s3rch-collection:v1:` plus `[predicate, set, label]`; labels are at most 40 code
units and the complete statement stays inside the existing 280-character limit.
References do not create collections, membership, file grants or key deliveries.

Only current, proof-checked forum statements enter the collection projection.
The reader must separately have the group in the current protected Granted
catalog. A collection lists only entries on that catalog page. File names and
bytes are not exposed until the existing group-item opener has checked item and
group authority, retrieved ciphertext, decrypted it and rechecked authority.
Audio is excluded from this photo/video view. The ordinary media library remains
available for audio and sharing management.

The catalog has 16 bounded pages of at most four entries. Empty pages are valid.
After the reader explicitly opens the catalog, the visible page refreshes every
two seconds. Entries and temporary preview URLs have a maximum four-second
catalog lease, including while a refresh stalls. A fresh catalog check follows
decryption before a preview appears. Permission failure, loss of forum access,
identity changes, hidden tabs, collection removal, expiry and disposal clear
previews; decrypted byte buffers are wiped after use. Previously saved copies
cannot be recalled. No plaintext or catalog state is persisted by this view.

Tests substitute the media browser boundary and clock to exercise independent
grant refusal, concurrent authority/reference removal, byte cleanup, stalled
refresh expiry and URL revocation. Existing media contract tests retain the real
item/group authorization and encrypted-file implementation. No reader cases are
registered or activated, and no shared-host or deployment acceptance is claimed.
Hosted #301 readiness remains with its owners.
