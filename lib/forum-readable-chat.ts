import type { FeedItem } from "./feed-types";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { isPublicSquadPrincipal } from "./squad-view";

/** Select visible rows without dropping the subscription's proof and retraction history. */
export function readableForumChat(rows: readonly FeedItem[], forum: string, sessionKey: string | null,
  graph: Pick<ForumAuthorityGraph, "principalForKey" | "checkForumSee" | "checkDirectSee" | "checkPost"> | undefined,
  valid: (row: FeedItem) => boolean, now: number): FeedItem[] {
  const viewer = sessionKey && graph?.principalForKey(sessionKey, now);
  if (!graph || !viewer || isPublicSquadPrincipal(viewer) || !graph.checkForumSee(forum, viewer, now).allowed) return [];
  return rows.filter(row => valid(row) && graph.checkDirectSee(row.id, row.author, now).allowed &&
    graph.checkPost(row.id, row.author, now).allowed && graph.checkForumSee(row.id, viewer, now).allowed);
}
