import { isForumObjectId, isSeaPubkey, sameEmbeddedPrincipal } from "./identity/forum-check";
import { PILOT_AGENTS, PILOT_FORUM_ID, PILOT_FORUM_LABEL, PILOT_OWNER } from "./forum-squad-fixture";

export type LiveSquadSpec = Readonly<{ forumId: string; owner: string; label: string }>;
export type SquadView = Readonly<LiveSquadSpec & {
  live: boolean; key: string;
  storage: Readonly<{ needs: string; status: string; alarm: string }>;
}>;
const publicPrincipals = new Set([PILOT_OWNER, ...PILOT_AGENTS.map(agent => agent.status.seaPubkey)]);
export const isPublicSquadPrincipal = (principal: string) => publicPrincipals.has(principal);
/** Selects a namespace, never authority. Live callers must separately provide a
 * trusted ForumAuthoritySource. Missing sources remain denied. Never accept a
 * query-string switch that enables the public fixture namespace. */
export function squadView(live?: LiveSquadSpec): SquadView {
  if (live !== undefined && (!live || typeof live !== "object" || Array.isArray(live) ||
      Object.keys(live).sort().join() !== "forumId,label,owner")) throw Error("Invalid live Squad configuration");
  const spec = live ? { forumId: live.forumId, owner: live.owner, label: live.label } : { forumId: PILOT_FORUM_ID, owner: PILOT_OWNER, label: PILOT_FORUM_LABEL };
  if (live && (!isForumObjectId(spec.forumId, "forum") || !isSeaPubkey(spec.owner) ||
      !sameEmbeddedPrincipal(spec.owner, spec.forumId) || spec.forumId === PILOT_FORUM_ID ||
      isPublicSquadPrincipal(spec.owner) || typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 80))
    throw Error("Live Squad requires a separate owner and namespace");
  const key = `s3rch:squad:v2:${live ? "live" : "demo"}:${spec.forumId}:${spec.owner}`;
  return Object.freeze({ ...spec, live: !!live, key,
    storage: Object.freeze({ needs: key + ":need-high-water", status: key + ":status-high-water", alarm: key + ":alarm-floor" }) });
}
