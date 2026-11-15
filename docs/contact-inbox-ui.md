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

The production `createFirstContactClient.accept` now consumes the published
SociACL browser acceptance API. It binds the explicit decision to the displayed
request, requires the restored issuer keyring and current authority, and commits
the confidential grant to the existing outbox before returning. It neither
delivers nor acknowledges that grant. Retry delivery must use committed bytes.
The package is from SociACL `8d75c494dd35b95b78fa012a6f26b0e56585766d`, with
SHA-256 `1db82fa0cd896db45384b943c29fab592262cc40733b92d0d23bda345417e232`.

The registered UI suite also reports `consumer-crypto-acceptance`, exercising
the production client with real browser crypto and IndexedDB, two public
synthetic identities and a substituted ciphertext transport. It verifies explicit
acceptance, recipient opening and retained outbox bytes after reopening the store.
This case does not qualify hosted discovery, grant delivery or messaging.

Infra confirmed that no contacts descriptor/keyring provisioning contract is
staged. The existing ACL keyring route handles recovery envelopes and wraps,
not a contacts registry or durable block decisions. A live mount still requires
those interfaces; do not generate replacement contact secrets for existing
accounts or interpret a transport digest as sender authority.
