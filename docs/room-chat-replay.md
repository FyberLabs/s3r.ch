# Bounded room-history replay (#485)

`lib/room-chat-replay.ts` is an inactive consumer contract. It is not imported by
room subscriptions or UI. The current live queue can still lose unverified
candidates during overload. This change does not close #485.

The owning transport must provide immutable snapshots with a stable identifier,
zero-based offsets, and gap-free ordered rows. Each request specifies the room,
snapshot (null for the first page), offset, limit, and cancellation signal. The
JSON response contains `snapshot`, the requested `offset`, `rows` (each containing
`key` and `value`), and `done`. Only the owner can establish snapshot completeness;
Gun map callbacks, timers, or an empty live subscription are not evidence of it.
The owner must enforce bounds while reading/serializing, before returning bytes,
and stop work on cancellation. Snapshot IDs are at most 256 characters.

The consumer accepts at most 32 rows and 512 KiB of UTF-8 per page, with at most
16,384 UTF-16 code units per serialized entry and 1,024 per key. It decodes only
bounded JSON, serializes admission, and yields after eight candidates and between
pages. It retains one page, not the accumulated history. Source errors and invalid
pages fail closed. A current authority failure or binding replacement cancels the
run; create a new consumer to restart from a new snapshot. The binding must change
on room, identity, or controller replacement, even when the public key is unchanged.
Call `close` immediately during teardown; the source must settle cancelled reads.

Every row passes existing signed-room admission, including room/transport ID,
current key, parent permissions, and signature checks. Display receives only a
currently valid admitted object. The sink must retain its existing bounded history
and current-proof filtering; receipt is not perpetual display authority. Repeated
`start` calls share one run. A finite source snapshot eventually completes; no
consumer can detect an owner that silently omits rows or lies about `done`.

Unit tests substitute immutable paging and the authority graph, while using real
SEA signatures. They cover a finite burst over 8,192 candidates, serial admission,
malformed paging, snapshot replacement, and teardown. Actual transport paging,
concurrent-write snapshot isolation, permission refresh, and end-to-end mounting
still require owner implementation and CI evidence. No reader cases are registered.
