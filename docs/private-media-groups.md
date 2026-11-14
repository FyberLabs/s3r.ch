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
