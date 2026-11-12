# Private contact-lane transport through Spanopticon

`lib/contact-lane-transport.ts` supplies the ciphertext transport adapter for
recipient-approved SociACL lanes. Pass the trusted Spanopticon HTTPS origin to
`createContactLaneTransport`. This is an application configuration value, never
an arbitrary URL from a peer, message, wallet or Gun row.

The adapter calls Spanopticon's edge at
`/api/v1/acl/sociacl/contact-lanes/{laneId}/messages`; the edge routes to the ACL
service. Browser credentials, cookies, tenant IDs and account keys are omitted.
Configure the edge's `CPEDGE_CORS_ORIGINS` to include the s3r.ch origin. Do not
point the browser at private ACL service addresses.

Call `append(laneId, sealedCiphertext)` only after recipient acceptance supplies a
verified lane grant and the message has been signed and encrypted with the
appropriate client contract. Call `read(laneId)` to retrieve bounded ciphertext;
then decrypt, authenticate the sender and check current grants before rendering.
The adapter verifies transport digests, which are not signatures or ACL answers.
The adapter cannot determine whether arbitrary bytes are correctly encrypted.

The API accepts 32–65536 ciphertext bytes, up to 128 messages / 1 MiB per lane,
30 new writes per lane per rolling minute, and seven-day retention. Identical
retries do not extend retention. A 429/503 is a transport failure, not permission
to bypass encryption or fall back to an account-indexed Gun path. The adapter
refuses redirects, oversized responses, duplicate IDs and mismatching digests.

This adds transport support; it does not enable a stranger-request UI or invent
the still-pending first-contact encrypted envelope. s3r.ch's existing Granted
inbox is not silently migrated or treated as a private contact lane.
