# Forum business ledger

The Memory map tab and President / PM strip open a ledger for a currently
authorized live forum member. Preview forums retain the unavailable view.
Entries record decisions or open work, with an optional SEA account as the
recorded owner. This label does not assign a role or change any grant.

An entry is an append-only forum statement: `s3rch-ledger:v1:` followed by the
canonical JSON array `[kind, text, owner-or-null]`. Text is limited to 120 UTF-16
code units and the complete statement to the existing 280-character limit.
Corrections are new entries; this is not a task status or assignment protocol.

Publication uses the existing protected statement admission, fresh forum and
object post checks, SEA signature, and authenticated Gun publication. The ledger
reads only the existing proof-checked, current-reader chat projection. Loss of
forum access, expired proofs or identity replacement removes the view and draft.
No raw transport row, recorded owner, role label or parsed JSON establishes access.

The view contains the currently available bounded history, not a completeness
claim; transport replay remains #485. The existing forum transport's visibility
and storage model is unchanged. This does not add encrypted media, media Memory
map access, a separate state store, bot events, or private reader registration.

PR CI runs the ledger format, current-authority projection and UI contracts
alongside existing statement signing/admission and revocation tests. Projection
unit tests substitute the authority graph explicitly. No shared-host scenario,
manual nightly invocation or new publication gate is required by this change.
