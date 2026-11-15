# Contact inbox UI boundary

`ContactInbox` presents explicit accept/decline decisions, accepted contacts,
blocking, messages, and a bounded draft. It takes a `ContactInboxSession` created
by a trusted browser adapter. The session must authenticate current identity,
contact decisions and message grants; UI rows are never admission evidence.

A prepared message retains its submission object after an ambiguous response.
Retry calls that same object instead of creating a second ciphertext. The adapter
must durably retain bytes and recheck identity, block state and recipient grants
on every submission. Lock/logout, authority change and session replacement clear
private UI state. Backend errors are not shown verbatim.

The panel is not mounted in the live site yet. The remaining composition needs
current signed descriptor publication/discovery, the unlocked contact-secret
keyring, persisted contact/block decisions, authenticated grant delivery, and the
message encryption/admission adapter. A bare SEA pair is not this capability.
The existing login and group owners retain their interfaces and worktrees.

`scripts/test-contact-inbox.mjs` is an isolated scheduled-only UI contract with
synthetic identity, journal and transport adapters. Its cases cover explicit
acceptance, ambiguous retry without duplicate preparation, peer messages,
blocking and private-state isolation. It reports named cases without private
values. It is not evidence for hosted two-identity messaging or cryptographic
admission. The SociACL browser acceptance tests independently cover the real
canonical envelope, signatures and atomic outbox. No hosted reader case or login
fixture is installed by this change.
