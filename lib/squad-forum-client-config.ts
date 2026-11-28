import type { ForumAuthorityConfig } from "./identity/forum-authority";
import { FORUM_AUTHORITY_CONFIG } from "./identity/forum-authority";

export type SquadForumClientConfig = Readonly<{
  origin: string;
  config: ForumAuthorityConfig;
  sessionBase: string;
  authorityEndpoint: string;
  statementEndpoint: string;
}>;

export function squadForumClientConfig(origin: string): SquadForumClientConfig {
  return Object.freeze({
    origin,
    config: FORUM_AUTHORITY_CONFIG,
    sessionBase: "/api/identity/sea",
    authorityEndpoint: "/api/squad/authority",
    statementEndpoint: "/api/squad/statement",
  });
}