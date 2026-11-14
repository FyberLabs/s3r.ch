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
