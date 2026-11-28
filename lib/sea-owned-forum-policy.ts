import type { ForumAuthorityConfig } from "./identity/forum-authority";

/** Per-forum authority comes from the owner SEA key and signed ACL rows, not deployment policy. */
export const SEA_OWNED_FORUM_AUTHORITY: ForumAuthorityConfig = Object.freeze({
  keys: Object.freeze([]),
});