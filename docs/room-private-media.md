# Private media references in room chat

Room chat can carry a `s3rch-media:v1:` message containing a one-element JSON
array with a canonical media object ID. It contains no filename, key, wrap,
backend URL or grant. The message uses the same signed author, room binding and
current room admission as ordinary chat. Unadmitted rows cannot supply players.

Open **Room media**, choose an owned file from the paged library, preview an
audio or video file, then send its reference. Sending follows the current room's
publication consent: a Mine-only room retains chat locally until the owner
confirms public sharing. Public chat exposes the reference to everyone; the
referenced ciphertext remains private. Sending a reference does not add readers.
Manage file sharing in My media before expecting another person to open it.

A reader explicitly opens a reference using the existing private-media session,
read-wrap authorization and authenticated decrypt path. Every open rechecks file
access before downloading ciphertext. A reference need not appear on the current
catalog page; catalog membership is navigation, not authorization. No arbitrary
URL is accepted and no player receives a remote storage URL. The decrypted
preview uses a temporary blob URL and the shared audio/video player.

Closing the panel or preview, hiding the document, changing identity, or losing
the selected message's room admission clears pending work and the preview.
The existing media library also clears previews on unlock changes and session
expiry. Player teardown pauses playback and releases its source. Access changes
cannot retract copies already saved by an authorized reader.

The panel shows at most the latest 64 admitted file references. It does not
change the room transport's bounded history behavior (see #485). This slice
does not implement group grants, provision storage, or establish hosted readiness.

Validation includes real SEA signature units with a substituted authenticated
room graph, parser refusal units and CI-only media-library contracts. The audio
and video browser fixtures use real encryption/decryption, synthetic HTTP
responses and an explicitly substituted room-admission callback; they cover
playback, denied file access, room admission loss and cleanup. They do not
exercise deployed identities, storage or the shared nightly journey.
