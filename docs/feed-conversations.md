# Public cached conversations

Reply and root references are additive Gun v1 JSON fields. They have bounded identifiers, public HTTP(S) permalinks and optional source-provided author handles. Empty updates and unshare tombstones clear them; persisted source windows retain sanitized references.

Reply markers open a public-cache conversation without signing in. The API reads the atomic public feed snapshot and limits each response to eight ancestors, the selected item and sixteen direct replies, with a 512 KiB response cap. Parent traversal is source-scoped and cycle-safe. Missing cached parents remain visible as unavailable placeholders. Requests are limited to 120 per minute per replica.

This increment does not pull missing parents from providers. A parent outside the successful source window can therefore be unavailable even when its original permalink still works. Provider-specific bounded context retrieval remains tracked in #409. The UI reuses #408's media component, whose proxy admits only current public snapshot attachments.
