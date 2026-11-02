/** Retyped from SociACL b7f9bc59 typescript/src/post.js checkForumChildWrite.
 * No runtime dependency. Group read is deliberately not direct see + post. */
import { isForumObjectId, isSeaPubkey, sameEmbeddedPrincipal } from "./forum-check";
import { checkSee, type CheckResult, type SeeGraph } from "./check";
import { recoveryInteger } from "./forum-recovery-records";

export function checkForumChildWrite(graph: SeeGraph, forum: string, agent: string,
  child: string, writer: string, now: number): CheckResult {
  if (!isForumObjectId(forum, "forum") || !isSeaPubkey(agent) || !isSeaPubkey(writer) ||
      !sameEmbeddedPrincipal(agent, child)) return { allowed: false, reason: "bad-record" };
  if (!recoveryInteger(now) || !graph.hasObject(child)) return { allowed: false, reason: "missing-object" };
  if (graph.ownerOf(child) !== agent) return { allowed: false, reason: "bad-record" };
  const see = checkSee(graph, child, writer, now);
  if (!see.allowed || writer === agent) return see;
  return graph.checkPost?.(child, writer, now) ?? { allowed: false, reason: "missing-post" };
}
