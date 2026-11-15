# Contact inbox and live adapter

`/contacts` mounts `ContactsWorkspace` and `ContactInbox`. The existing unlocked
identity supplies keys; the contacts adapter checks the authenticated server
session, current signed identity history and configured witness policy. No login
or group interface is changed. Unset contacts configuration leaves the page
unavailable.

The ACL contacts contract publishes signed descriptors and stores an encrypted
private vault. Source checkpoints protect document revisions. Every browser
write signs the expected revision, complete-authority fence and ciphertext digest.
A peer history or trust change refuses the write even when the document revision
is unchanged. An ambiguous write is reconciled against retained ciphertext before
retrying; intervening decisions are not overwritten.

The private vault holds restored contact keys, pending requests, decisions,
blocks, grants, replay identifiers, messages and prepared ciphertext. An existing
keyring must be restored explicitly when the vault is absent; the adapter never
creates replacement contact secrets. The current SEA encryption key derives a
non-exportable vault key. Rotated identities cannot silently overwrite a vault
whose key history they cannot open; recovery migration is separate work.

A sender verifies the recipient's signed descriptor and encrypts the request.
Acceptance uses SociACL's native browser acceptance API and commits the exact
confidential grant before delivery. Its reply lane is derived from the encrypted
request nonce and request ID. The sender opens the grant and sends a reciprocal
grant through the authorized lane. Text and reciprocal grants are signed and
AEAD encrypted for the current recipient. Ciphertext transport digests provide
integrity checks only; they are not sender authentication.

Blocks remove outgoing commands and prevent message opening or preparation.
Prepared commands retain their ciphertext across ambiguous delivery, and check
current identity, blocks and grants before retrying. Requests can be disabled
without resetting the public descriptor revision. Lock, session change or hidden
page clears the mounted private view. The browser does not persist plaintext in
localStorage or IndexedDB.

`scripts/test-contact-inbox.mjs` remains central scheduled-only. Its UI cases use
substituted sessions. `consumer-crypto-acceptance` uses the real SociACL browser
API and IndexedDB. `live-adapter-contract` uses the production browser composition
and cryptography with two public synthetic identities and mocked authenticated
source/transport contracts: discovery, explicit acceptance, reciprocal grants,
messages, ambiguous retries, replay suppression, blocks and lock refusal. These
cases do not qualify hosted login or a provisioned two-account deployment.

The native package is SociACL `8d75c494dd35b95b78fa012a6f26b0e56585766d`, SHA-256
`1db82fa0cd896db45384b943c29fab592262cc40733b92d0d23bda345417e232`.
ACL journal installation and bound operator credentials remain explicit Infra
inputs. This change does not stage them or activate a hosted fixture.
