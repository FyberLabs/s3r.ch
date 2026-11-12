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
will require a separately specified chunk format. The private file descriptor below binds media type and filename to the encrypted
bytes. Routes and players still need current grant checks before using it.

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


## Private file description

`sealMediaFile` and `openMediaFile` layer a versioned file description inside the
existing reader envelope. Neither filename nor media type is sent to the provider
or placed in public metadata. The encrypted plaintext contains four magic bytes
`73 33 66 01`, a four-byte unsigned big-endian JSON byte count, UTF-8 JSON with
exactly `version: 1`, `name`, `mediaType`, and `length`, followed by the file bytes.
The byte count is bounded to 1024; `length` must match the nonempty file body.
All descriptor overhead counts toward the 64 MiB encrypted object limit.

Names are bounded to 255 UTF-8 bytes and reject paths, controls, bidi controls,
unpaired surrogates and surrounding whitespace. The initial media types are
PNG, JPEG, GIF, WebP, AVIF, MPEG/OGG/WAV/WebM/MP4 audio, and MP4/WebM/OGG video.
HTML, SVG, arbitrary executable types and MIME parameters are refused. This is a
format label, not a content scan or decoder safety guarantee. A player must use
the authenticated description rather than an untrusted public MIME hint.

Opening authenticates the ciphertext and current supplied grant context before
parsing the description. The returned body is a separate buffer; temporary packed
plaintext is cleared on success and failure where JavaScript permits. The helpers
still require independently verified enrollment, current Check and fresh epochs.
They do not install upload routes, grant persistence, quotas or a player.
