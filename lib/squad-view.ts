import { isForumObjectId, isSeaPubkey, sameEmbeddedPrincipal } from "./identity/forum-check";
import { PUBLIC_SQUAD_FORUM_ID, publicSquadPrincipals } from "./squad-public-principals";

export type LiveSquadSpec = Readonly<{ forumId: string; owner: string; label: string }>;
export type SquadView = Readonly<LiveSquadSpec & {
  live: boolean; key: string;
  storage: Readonly<{ needs: string; status: string; alarm: string }>;
}>;

const unsetStorage = Object.freeze({
  needs: "s3rch:squad:v2:unset:need-high-water",
  status: "s3rch:squad:v2:unset:status-high-water",
  alarm: "s3rch:squad:v2:unset:alarm-floor",
});

const unsetView: SquadView = Object.freeze({
  live: false,
  forumId: "",
  owner: "",
  label: "Squad",
  key: "s3rch:squad:v2:unset",
  storage: unsetStorage,
});

export const isPublicSquadPrincipal = (principal: string) => publicSquadPrincipals.has(principal);

/** Selects a namespace, never authority. Live callers must separately provide a
 * trusted ForumAuthoritySource. Missing sources remain denied. Never accept a
 * query-string switch that mounts test-vector roster data in product UI. */
export function squadView(live?: LiveSquadSpec): SquadView {
  if (live === undefined) return unsetView;
  const liveKeys = Object.keys(live);
  if (!live || typeof live !== "object" || Array.isArray(live) ||
      liveKeys.length !== 3 || liveKeys.some(k => k !== "forumId" && k !== "label" && k !== "owner"))
    throw Error("Invalid live Squad configuration");
  const spec = { forumId: live.forumId, owner: live.owner, label: live.label };
  if (!isForumObjectId(spec.forumId, "forum") || !isSeaPubkey(spec.owner) ||
      !sameEmbeddedPrincipal(spec.owner, spec.forumId) || spec.forumId === PUBLIC_SQUAD_FORUM_ID ||
      isPublicSquadPrincipal(spec.owner) || typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 80)
    throw Error("Live Squad requires a separate owner and namespace");
  const key = `s3rch:squad:v2:live:${spec.forumId}:${spec.owner}`;
  return Object.freeze({ ...spec, live: true, key,
    storage: Object.freeze({ needs: key + ":need-high-water", status: key + ":status-high-water", alarm: key + ":alarm-floor" }) });
}