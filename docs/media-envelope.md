# Private media envelope

`lib/media-crypto.ts` prepares opaque bytes for the s3r.ch tenant's Spanopticon
object store. This is a client encryption prerequisite for #300. Upload routes, confidential grant persistence and Check-authorized retrieval
require deployment configuration and registered signed media ownership; no upload UI is enabled.

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

## Authenticated object transport

`PUT /api/media/{media_object_id}` accepts only the opaque encrypted envelope,
with `Content-Type: application/octet-stream`, bounded `Content-Length`, and
`X-Media-SHA256`. The canonical media object must already have signed ownership
in the deployment-provisioned complete authority source. The route cannot enroll
an object or accept a client-supplied history. Only its current SEA owner may
upload. The private `media/object-index-v1` record binds the object to exactly
one ciphertext digest and length; replacing it requires a new media object.

`GET` requires the current owner's access or a current direct See grant. It
returns only ciphertext as an attachment, never file names, MIME descriptions,
reader wraps, storage credentials or provider URLs. Each operation authenticates
again and reads fresh authority before returning bytes or upload success. Read
fetches use same-origin browser metadata or an explicit matching Origin.

The primary index uses conditional writes to reserve at most 128 objects and
256 MiB per tenant before an object upload. Each file is at most 64 MiB, including
the encrypted envelope; two requests may be active per configured worker. A
failed upload retains its reservation so an identical retry is safe; there is
no automatic deletion or quota reclamation. This is a bounded initial transport,
not a billing quota system. The media key needs object read/write and media
record read/write scopes, with no cache or delete permission.

Routes return 503 until dedicated media settings and the trusted authority source
are configured. They currently use the existing primary Squad source and do not
claim the broader trusted-history migration is complete. Browser upload/playback,
confidential reader-wrap delivery, object admission, quota management UI, and
scheduled browser qualification remain in #300 and its dependent issues.

## Private ownership registration

When media storage is configured, `POST /api/media/{object}` accepts a bounded
JSON object with exactly `object`, `owner`, `issuedAt`, and `sig`. The ID must be
a canonical `media_` object and match the URL. The signature is the existing
SociACL `sociacl-object-v2` P-256 ownership record, signed by the owner's current
SEA signing key. A same-origin human session must resolve to that owner through
the deployment's complete, fresh key history. A supplied public key or an
unenrolled principal cannot create its own history through this route.

The signed record is held in the private Spanopticon `media/ownership-index-v1`
record. It is reverified on each upload and download; storing it never caches an
allow decision. There are at most 128 registrations per tenant, with conditional
updates and three bounded conflict attempts. Exact retries succeed without a new
write. A replacement needs a strictly later issuance time and a currently valid
owner signature. This permits re-signing after key rotation without changing the
object's identity or immutable ciphertext mapping.

Registration returns an empty 201 response. It does not upload ciphertext, publish
a post, add an assignment destination, share with a forum, distribute a key wrap,
or grant a reader. The ciphertext route's separate byte and object quotas still
apply. Registration and upload failures retain their records for reconciliation;
there is no deletion or capacity reclamation API yet. Reader grant and confidential
wrap delivery, client upload/playback controls, and replacing the primary Squad
history source remain separate unfinished work.
