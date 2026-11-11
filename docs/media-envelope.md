# Private media envelope

`lib/media-crypto.ts` prepares opaque bytes for the s3r.ch tenant's Spanopticon
object store. This is a client encryption prerequisite for #300. Upload routes,
key wrapping and Check-authorized retrieval are still to be connected; media
uploads are not enabled by this module.

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
