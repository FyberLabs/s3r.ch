import { sha256, stringToHex } from "viem";
import { toGunNode, type FeedItem } from "./feed-types";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { forumChatTag, isSeaPubkey } from "./identity/forum-check";
import { isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";

export type ReportParents = Readonly<{ fleet: LiveSquadSpec; command: LiveSquadSpec }>;
export type ForwardHop = "fleet" | "command";
export type ReportPath = Readonly<{ squad: LiveSquadSpec } & ReportParents>;
const reportHash = (text: string) => sha256(stringToHex(text));
export const reportRevision = (row: FeedItem) => reportHash(JSON.stringify(toGunNode(row)));

export function signedForward(statement: string, signer: string) {
  return "s3rch-signed-forward:" + JSON.stringify([signer, statement]);
}

export function canReadHop(graph: Pick<ForumAuthorityGraph, "ownerOf" | "checkForumSee">, path: ReportPath, hop: ForwardHop,
  report: FeedItem, principal: string, now: number) {
  if (!principal || isPublicSquadPrincipal(principal) || !report.tags.includes("report") ||
      !report.tags.includes(forumChatTag(path.squad.forumId))) return false;
  const forums = hop === "fleet" ? [path.squad, path.fleet] : [path.squad, path.fleet, path.command];
  return forums.every(f => graph.ownerOf(f.forumId) === f.owner && graph.checkForumSee(f.forumId, principal, now).allowed) &&
    graph.checkForumSee(report.id, principal, now).allowed;
}

export function canForward(graph: ForumAuthorityGraph, path: ReportPath, hop: ForwardHop,
  report: FeedItem, principal: string, now: number) {
  return canReadHop(graph, path, hop, report, principal, now) && graph.checkPost(path[hop].forumId, principal, now).allowed;
}

// Sign only a reference. A Command forward commits to the exact accepted Fleet signature.
export function forwardStatement(path: ReportPath, hop: ForwardHop, row: FeedItem, parent: string | null) {
  if ((hop === "command") !== !!parent) throw Error("Missing or unexpected previous hop");
  return JSON.stringify(["s3rch/report-forward/v1", path.squad.forumId, path.fleet.forumId,
    hop === "command" ? path.command.forumId : null, row.id, reportRevision(row), parent ? reportHash(parent) : null]);
}

export function forwardFields(data: unknown) {
  function parse(value: unknown) {
    if (typeof value !== "string" || value.length > 8192) return null;
    try {
      const envelope = JSON.parse(value);
      if (Array.isArray(envelope) && envelope.length === 2 && typeof envelope[0] === "string" &&
          isSeaPubkey(envelope[0]) && typeof envelope[1] === "string" && envelope[1].startsWith("SEA"))
        return { signer: envelope[0] as string, sig: envelope[1] as string };
    } catch { /* Unknown peer fields carry no authority. */ }
    return null;
  }
  const fields = data as { fleetForward?: unknown; commandForward?: unknown } | null;
  return { fleet: parse(fields?.fleetForward), command: parse(fields?.commandForward) };
}
