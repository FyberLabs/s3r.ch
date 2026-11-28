import { randomBytes } from "node:crypto";
import { isForumObjectId, isSeaPubkey, sameEmbeddedPrincipal, seaToPrincipalKey } from "./identity/forum-check";

export function mintSquadForumId(owner: string, entropy = randomBytes(16).toString("hex")): string {
  if (!isSeaPubkey(owner)) throw Error("Owner SEA pubkey required");
  const id = `forum_${seaToPrincipalKey(owner)}_${entropy}`;
  if (!isForumObjectId(id, "forum") || !sameEmbeddedPrincipal(owner, id)) throw Error("Invalid squad forum id");
  return id;
}