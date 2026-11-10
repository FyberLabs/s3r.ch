import { sha256, stringToHex } from "viem";
import { toGunNode, type FeedItem } from "./feed-types";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { forumChatTag, isSeaPubkey, type ForumNeed } from "./identity/forum-check";
import { isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";

export type ReportParents = Readonly<{ fleet: LiveSquadSpec; command: LiveSquadSpec }>;
export type ForwardHop = "fleet" | "command";
export type ReportPath = Readonly<{ squad: LiveSquadSpec } & ReportParents>;
const reportHash = (text: string) => sha256(stringToHex(text));
export const reportRevision = (row: FeedItem) => reportHash(JSON.stringify(toGunNode(row)));

export function signedForward(statement: string, signer: string) {
  return "s3rch-signed-forward:" + JSON.stringify([signer, statement]);
}

export type BoardLevel = "squad" | ForwardHop;
export type BoardSource = FeedItem | ForumNeed;
export const isNeed = (row: BoardSource): row is ForumNeed => "severity" in row;
export const sourceRevision = (row: BoardSource) => isNeed(row) ? reportHash(JSON.stringify([
  row.id, row.forumId, row.subject, row.severity, row.body, row.stated, row.hamState, row.ts, row.spec ?? null, row.acceptedOffer ?? null,
])) : reportRevision(row);

export function canReadBoard(graph: Pick<ForumAuthorityGraph, "ownerOf" | "checkForumSee">, path: ReportPath,
  level: BoardLevel, principal: string, now: number) {
  if (!principal || isPublicSquadPrincipal(principal)) return false;
  const forums = level === "command" ? [path.squad, path.fleet, path.command] : level === "fleet" ? [path.squad, path.fleet] : [path.squad];
  return forums.every(f => graph.ownerOf(f.forumId) === f.owner && graph.checkForumSee(f.forumId, principal, now).allowed);
}

export function canReadHop(graph: Pick<ForumAuthorityGraph, "ownerOf" | "checkForumSee">, path: ReportPath, hop: BoardLevel,
  report: BoardSource, principal: string, now: number) {
  if (isNeed(report)) {
    if (report.forumId !== path.squad.forumId || !report.stated || (hop === "command" && report.severity !== "emergency")) return false;
  } else if (!report.tags.includes("report") || !report.tags.includes(forumChatTag(path.squad.forumId))) return false;
  return canReadBoard(graph, path, hop, principal, now) &&
    graph.checkForumSee(report.id, principal, now).allowed;
}

export function canForward(graph: ForumAuthorityGraph, path: ReportPath, hop: ForwardHop,
  report: BoardSource, principal: string, now: number) {
  return canReadHop(graph, path, hop, report, principal, now) && graph.checkPost(path[hop].forumId, principal, now).allowed;
}

// Sign only a reference. A Command forward commits to the exact accepted Fleet signature.
export function forwardStatement(path: ReportPath, hop: ForwardHop, row: BoardSource, parent: string | null) {
  if ((hop === "command") !== !!parent) throw Error("Missing or unexpected previous hop");
  return JSON.stringify([isNeed(row) ? "s3rch/need-escalation/v1" : "s3rch/report-forward/v1", path.squad.forumId, path.fleet.forumId,
    hop === "command" ? path.command.forumId : null, row.id, sourceRevision(row), parent ? reportHash(parent) : null]);
}

export function withdrawalStatement(statement: string, signature: string) {
  return JSON.stringify(["s3rch/withdraw-forward/v1", statement, reportHash(signature)]);
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
  const fields = data as { fleetForward?: unknown; commandForward?: unknown; fleetWithdrawal?: unknown; commandWithdrawal?: unknown } | null;
  return { fleet: parse(fields?.fleetForward), command: parse(fields?.commandForward),
    fleetWithdrawal: parse(fields?.fleetWithdrawal), commandWithdrawal: parse(fields?.commandWithdrawal) };
}
