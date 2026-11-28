import type { ForumAuthorityConfig } from "./identity/forum-authority";
import { SEA_OWNED_FORUM_AUTHORITY } from "./sea-owned-forum-policy";

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
    config: SEA_OWNED_FORUM_AUTHORITY,
    sessionBase: "/api/identity/sea",
    authorityEndpoint: "/api/squad/authority",
    statementEndpoint: "/api/squad/statement",
  });
}