# Private media group policies

The owner client can read the protected set-owner context, prepare a signed
settlement policy with the unlocked set-owner key, and submit the retained signed
configuration against a fresh source fence. Preparation uses the packed SociACL
producer and clears its temporary key copy. A media owner cannot sign policy for
a different set owner. Already signed policies can be relayed separately.

The browser and BFF validate canonical scope, owner, key, revision and window;
the ACL source remains responsible for signatures and current enrolled history.
A stale fence or lost response never triggers automatic replay. These helpers do
not yet provide group membership editing, select group epochs, or deliver wraps.
Older ACL sources refuse the new operations without affecting direct sharing.

The owner client also reads `groupAuthorityView(object, owner)` through the
fixed-session BFF. ACL returns the direct snapshot, all-scope group projection,
selected set-owner policy and named current identity bindings from one protected
transaction. The browser validates the exact owner, scope, policy key and named
binding set while keeping direct cancellations separate from group membership.
A missing policy remains null. This view is preparation input, not authorization
to deliver a wrap; group epoch/status admission and delivery remain pending.

`prepareGroupRow` signs an owner object-set row, the owner's own membership
assent, or the owner's cancellation through `sociacl-ids/group-signing`.
The scope and unsigned row are detached before awaiting the protected owner
view. The service supplies the issuance time and current owner key; the temporary
scalar copy is cleared. Another party's assent is refused. The result is a signed
envelope only: the caller explicitly submits it with `appendGroupRows`, which
obtains a new fence and still requires native admission. This does not create the
other party's assent, an epoch, or a delivery grant.

`groupRowsState` reconciles an exact signed batch through the protected
`group-check` route. `appendGroupRows` checks first: an applied batch returns
without another write; an absent batch is submitted once with the returned
fresh fence. A lost response is not retried automatically. Callers retain the
original signed rows and reconcile them before another attempt. Applied means
retained, not live authorization: an older object-set row can remain retained
after a later withdrawal without regaining access. Current-history refusal,
stale fences and session changes still stop the operation.

The read-only `/api/media/group-consent-view` BFF takes `{object,predicate,set}`
under an existing fixed reader binding. The browser helper requires the expected
member and scope, validates the separate assents and exact unsigned member draft,
and refuses stale replies. The BFF rechecks the browser session after the ACL
request and never forwards a caller-selected member or credential. No consent
signature, append, group epoch, or delivery is performed here. Safe member writes
and the group sharing UI remain separate work.

Member consent now has a separate browser client and unlocked-identity adapter.
Preparation signs only the authenticated member role with the current protected
key; key copies are wiped after use. Withdrawal preparation does not require a
surviving set-owner invitation, and uses same-HAM stated 0 with no cancellation
acknowledgements. The fixed-reader BFF accepts only that reader's member row.
The ACL credential must additionally carry media write scope for append.

Append first checks the exact signed row. Applied rows return without another
write; absent rows get one write attempt against the fresh fence. A lost response
is left for explicit reconciliation, and an expired absent signature must be
prepared again. These methods do not persist a browser recovery journal or add
group delivery; durable UI recovery and group epoch delivery remain separate.

## Independent group commands

The protected `/api/media/groups/{action}` routes create a group from an owned
media anchor and manage the group's independent membership journal. The anchor
supplies trusted policy at creation; later membership does not depend on an
object-set edge. Creation does not enroll the owner as a member. Set-owner and
member assents remain separate, and withdrawal does not require a surviving
invitation or an encryption key.

The unlocked browser prepares group configuration and membership signatures
from fresh protected views. `runGroupCommand` saves the exact signed command in
a separate encrypted IndexedDB journal before sending it. It records the fresh
attempt time before each write. `resumeGroupCommand` reconciles that command
without generating a replacement signature; an expired absent membership command
must be cleared after reconciliation before preparing a new one. The dedicated
Web Lock and journal revision check prevent competing tabs from replacing the
saved command. Locking or changing identity aborts in-flight browser operations.

My media can inspect, retry and clear the saved independent group command after
loading the current principal's catalog. Clearing requires source confirmation:
an applied command can be cleared, while an absent attempted command must wait
until its write fence has expired. An unavailable source retains the command.
The UI clears its visible selection when the identity session changes. Clearing
local recovery never reverses an accepted change.

Group creation and membership acceptance alone do not grant media access.
Group-wide epoch selection, member key delivery, object-set sharing controls and
the hosted share/view/unshare scenario remain required before group sharing is
complete. Existing per-object consent recovery remains separate from this
independent group journal.
