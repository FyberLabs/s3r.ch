# Private audio tags

Audio upload accepts up to 12 descriptive tags of 40 characters each. Tags are normalized and encrypted with the file descriptor and bytes. They do not enter public post metadata, allocation requests, grants or storage paths. Recording and picked-file uploads use the same uploader; interrupted uploads retain the encrypted descriptor in the existing recovery journal.

Untagged files retain the original S3F version-1 descriptor and encoding. Tagged audio uses S3F version 2 with a required, bounded, canonical `tags` array. The current reader supports both versions; older browser readers refuse version 2 until updated. Storage and authorization services continue handling the unchanged opaque ciphertext API, and grants, read-wrap authorization and settlement are unchanged. PNG meme tags remain in the existing PNG metadata path.

Tags appear only after authorized decryption and clear with the private preview on identity change, close or navigation. CI checks encrypted upload interruption/resume, exact audio bytes and tags after decryption, grantee playback and tag rendering, refused reads, and teardown. These are synthetic contracts, not hosted storage activation.
