# Private media envelope

`lib/media-crypto.ts` prepares opaque bytes for the s3r.ch tenant's Spanopticon
object store. This is a client encryption prerequisite for #300. Upload routes, confidential grant persistence and Check-authorized retrieval
are still to be connected; these modules do not enable media uploads.

Each encryption generates a fresh AES-256-GCM key and 96-bit nonce. Associated
data binds the envelope version, canonical tenant UUID and canonical SociACL
object ID. The stored binary layout is four bytes `73 33 6d 01`, a 12-byte nonce,
then ciphertext with its 16-byte authentication tag. The SHA-256 of these exact
bytes is the object address used by Spanopticon. Retrying an upload reuses the
same encrypted bytes and address. A new encryption generates a new key and nonce.
The 64 MiB provider limit includes all 32 bytes of envelope overhead.

The returned key is private material. Consumers must wrap it in owner/grant
material and check current access before releasing it. It must never appear in
a public post, storage request, URL or log. An object address is not permission.
The binding must come from the authorized object, not untrusted download metadata.
The decryptor validates the envelope, address and authentication tag before
returning any plaintext. Revoking a grant cannot erase plaintext or keys that a
reader already obtained.

This format encrypts a complete bounded object in browser memory. It does not
support authenticated partial playback or streaming decryption. Larger media
will require a separately specified chunk format. Media type, filename and other
metadata need their own authenticated private descriptor before player wiring.

## Reader-key handoff

`sealMediaForReaders` in `lib/media-reader-wraps.ts` snapshots the authorized
reader list and expected object/epoch/revision, encrypts the media, and uses
SociACL's `wrapItemDekToReaders` protocol. It returns ciphertext, its digest and
private reader wraps, and clears its temporary raw key. It rejects an empty
reader list. Only the ciphertext bytes belong in an object-store upload.

`openMediaForReader` first opens the wrap against independently trusted current
epoch information, then authenticates the media ciphertext and tenant/object
binding. It clears the temporary opened key on success or failure. Neither
function performs Check or establishes that a reader's encryption key belongs
to its account; the caller must verify enrollment, current Check and fresh
epoch status. JavaScript cannot guarantee complete memory erasure.

Wrap labels reveal reader/object routing information. Persist the entire wrap
inside confidential grant material, never public Gun metadata. This handoff
does not replace the future SociACL secret store or its epoch/rotation rules.
