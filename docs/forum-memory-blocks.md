# Forum and project memory blocks

This is the #333 design for bounded agent/project context attached to a forum or
project. It is distinct from #312's Memory map of photo, audio, video and shared
real moments. A block is curated text with its own access rules, not a media
album, a transcript archive or an automatic source of instructions.

## Object and attachment

A block has an opaque tenant-scoped object ID, a stable SEA owner, a short label,
a UTF-8 text body, a byte cap, a revision and creation/update timestamps. The
initial product cap is 8,192 UTF-8 bytes per body and 128 UTF-8 bytes per label.
Measure encoded bytes, not JavaScript string length, before accepting a write.
Reject oversized writes atomically; never silently truncate, split, summarize or
store an over-limit body and fix it later. The server enforces these bounds even
if the browser's byte counter or model token estimate disagrees.

Attachment is a separate typed record: tenant, block ID, parent kind (`forum` or
`project`), parent ID and revision. It contains no copy of the body. Creating an
attachment requires current block-owner authority and the parent's current
attach/manage permission. Detaching a block does not delete it or erase its
history. Deleting a parent does not silently transfer the block's ownership.
A block may have multiple authorized attachments without inheriting their grants.

Creation requires an admitted object allocation and a current owner. The
browser cannot establish ownership by inventing an ID or embedding a public key
in a JSON record. Storage object IDs identify stored bytes, not SociACL grants.
This consumer does not create a new allocation issuer or reinterpret the forum
statement endpoint as a general-purpose object allocator.

## Independent permission checks

Every body or label read requires current direct block access through SociACL.
Viewing the attachment inside a forum/project additionally requires current
parent access. Membership in a parent, possession of an attachment URL, or a
cached list entry is never a block grant. Listings omit inaccessible blocks,
including their labels and counts; a guessed ID receives the same unavailable
response whether it is missing or forbidden.

Writing requires the block's current write permission, not merely permission to
post in its parent. The service resolves the authenticated session key to the
current stable SEA principal and checks revocation, scope and complete signed
history. Wallet or Keycloak credentials may establish a linked session; they do
not replace the principal or grant access by themselves. Agents need their own
narrow current permissions; a human owner viewing a block does not delegate it.

Each operation binds tenant, block ID, expected revision and request ID. The
trusted storage service must check authorization and conditionally commit against
the same authority fence. A browser check followed by an unconditional put is
insufficient. Changed ACL/history or content revisions cause a conflict without
an overwrite. Retrying an already committed request is idempotent and cannot
replace newer content. Reads recheck permission before releasing protected data.

## Storage and lifecycle

Spanopticon owns the durable tenant store. Text, revisions and attachments remain
private product data; neither the public feed cache nor a public Gun record is
the system of record. The backend must expose bounded reads and conditional
writes with the authority-fence contract above. Encryption at rest, authenticated
transport and credential custody remain the backend's responsibility. A storage
path or scoped upload authorization is not a substitute for the block check.

A revision is immutable after commit. Current content is a conditional pointer;
conflicts return a protected current revision to an authorized editor for manual
comparison. Do not auto-merge a model's output over another writer. Historical
revisions require current block permission too. Their retention and deletion
follow the product's published category schedule; do not invent permanent
retention or unlimited history to implement this feature. Quotas must bound
revision count and total bytes as well as individual bodies.

The browser keeps an unsaved draft only in memory. On logout, key change, parent
change, revoked access or source replacement it clears loaded protected content,
previews and pending operations. Late responses cannot reinsert content into the
new session. No offline persistent body cache is enabled by this design.

## Agent context and owner UI

The forum/project view has a Memory blocks panel separate from Memory map. It
shows only authorized blocks, their labels, revision and byte use/cap. Creating,
attaching, editing and changing grants are distinct actions. The grant editor
shows the block's recipients rather than claiming that the parent membership
controls access. Unsaved changes and revision conflicts remain visible.

An agent context request checks every selected block independently at use time,
returns a bounded snapshot with block/revision attribution, and enforces a total
context budget. No silent fallback to a previously readable revision is allowed.
Block text is untrusted task data: it cannot grant tools, change AIuditor policy,
act as a system instruction or authorize writes to another block. Proposed agent
edits go through the same current permission, size and revision checks as human
edits. Automatic summarization cannot rewrite the authoritative block.

## CI acceptance and integration prerequisites

CI must exercise two principals sharing one forum/project while only one has a
block grant. The other cannot discover the label, read the body/history, supply
the block to an agent, or edit it. Also cover exact-cap and over-cap UTF-8 writes,
multibyte text, stale revision/fence, duplicate request IDs, cross-tenant IDs,
revoked writers during pending commits, logout/key-change response races,
detach/delete behavior, bounded histories and a private block attached to two
parents with different audiences.

The required service contracts are admitted block allocation, independent block
ACL operations, complete current history, atomic authorized conditional storage,
and authorized forum/project attachment management. The existing public-feed
cache and signed statement-admission endpoint do not provide these contracts.
Until they are available, #333 remains open; the app must not publish a mock
memory panel as durable private storage or derive block access from forum access.
