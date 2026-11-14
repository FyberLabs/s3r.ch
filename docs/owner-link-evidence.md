# Existing local wallet-link evidence

Preparation for #440 and Infra #1261. A signed-in account can choose **Export
wallet-link evidence** in its identity controls. This reads the existing local
record, verifies its stored EOA wallet signature against the exact current HTTPS
origin and SEA public key, and downloads only the public proof fields. It never
creates a key, asks for another signature, unwraps a private key, writes a record,
contacts an RPC endpoint or sends the proof to a server. Wrapped records work
without unlocking because their existing signed link is separate from the wrap.
Missing, foreign, malformed or unverifiable records refuse export.

Keep the downloaded file private: it links a wallet and SEA identity. Do not post
it in an issue or publish it to Gun. This is not a private-key backup.

The file is version 1 with kind `s3rch-local-wallet-link-evidence`, origin, wallet,
sea_public_key, message and signature. Consumers must independently verify it;
parsing a file or trusting its kind is not authentication. Contract-wallet proofs
that cannot be checked by the local EOA verifier fail closed.

This historical local signature alone does **not** establish current key
possession, global account uniqueness, current history/revocations, an authenticated
SociACL witness, or admission into ACL's Postgres source. Multiple devices can hold
separate local keys for a wallet. No consumer may select a preferred key to hide
conflicting evidence. #440 remains open for an authoritative complete resolution
path and Infra/ACL must leave installation and activation off until verified owner
admission exists. Normal user export is not shared TEST qualification; browser
qualification and deployed checks belong to scheduled CI.
