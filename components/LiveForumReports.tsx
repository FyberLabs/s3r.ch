"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FeedGun } from "./GunPeerProvider";
import { formatClock, shortSea } from "@/lib/forum-squad";
import type { FeedItem } from "@/lib/feed-types";
import type { ForumAuthorityGraph } from "@/lib/identity/forum-authority";
import { forumStatementSoul } from "@/lib/identity/forum-check";
import type { SeaPair } from "@/lib/identity/sea";
import { forumSoulNode } from "@/lib/forum-transport";
import { readForumSignature, signForumRecord } from "@/lib/forum-sign";
import { canForward, canReadHop, forwardStatement, signedForward, reportRevision, type forwardFields, type ForwardHop, type ReportPath } from "@/lib/forum-report-forward";
import { btnSecondary } from "@/lib/brand-ui";

type Props = {
  path: ReportPath; graph: ForumAuthorityGraph; gun: FeedGun; reports: FeedItem[];
  evidence: (report: FeedItem) => ReturnType<typeof forwardFields> | undefined;
  sessionKey: string; pair: () => SeaPair | null; valid: (row: FeedItem) => boolean;
};
type Evidence = { signer: string; key: string; sig: string; statement: string };

function useHop(wire: ReturnType<typeof forwardFields>["fleet"] | undefined, statement: string | null, graph: ForumAuthorityGraph) {
  const [proof, setProof] = useState<Evidence | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const key = wire && graph.writerKey(wire.signer, now, now);
  useEffect(() => {
    let active = true;
    if (wire && key && statement) {
      void readForumSignature(wire.sig, key).then(payload => {
        if (active && payload === signedForward(statement, wire.signer)) setProof({ ...wire, key, statement });
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [wire, key, statement]);
  return wire && proof && proof.signer === wire.signer && proof.sig === wire.sig && proof.key === key &&
    proof.statement === statement ? proof : null;
}

function LiveReport({ path, graph, gun, sessionKey, pair, valid, evidence, row, level }: Omit<Props, "reports"> & {
  row: FeedItem; level: "squad" | ForwardHop;
}) {
  const [notice, setNotice] = useState("");
  const fleetText = forwardStatement(path, "fleet", row, null);
  const fleet = useHop(evidence(row)?.fleet, fleetText, graph);
  function writerAllowed(signer: string, hop: ForwardHop, now: number) {
    return valid(row) && canForward(graph, path, hop, row, signer, now);
  }
  const now = Math.floor(Date.now() / 1000);
  const fleetAccepted = fleet && writerAllowed(fleet.signer, "fleet", now);
  const commandText = fleetAccepted ? forwardStatement(path, "command", row, fleet.sig) : null;
  const command = useHop(evidence(row)?.command, commandText, graph);
  const viewer = graph.principalForKey(sessionKey, now);
  const hop = level === "squad" ? "fleet" : "command";
  const text = hop === "fleet" ? fleetText : commandText;
  const destinationVisible = viewer && canReadHop(graph, path, hop, row, viewer, now);
  const signed = destinationVisible && (hop === "fleet" ? fleetAccepted : command && writerAllowed(command.signer, "command", now));
  function maySend() {
    const at = Math.floor(Date.now() / 1000);
    return !!text && !!viewer && graph.principalForKey(sessionKey, at) === viewer && pair()?.pub === sessionKey &&
      writerAllowed(viewer, hop, at) && (hop === "fleet" || (!!fleet && graph.writerKey(fleet.signer, at, at) === fleet.key &&
        writerAllowed(fleet.signer, "fleet", at)));
  }
  const current = useRef<(() => boolean) | null>(null);
  useLayoutEffect(() => { current.current = maySend; return () => { current.current = null; }; });
  async function send() {
    const guard = current.current, signingPair = pair();
    if (!text || !guard?.() || !signingPair || !viewer) return;
    try {
      const signature = await signForumRecord(signedForward(text, viewer), signingPair);
      if (!signature || current.current !== guard || !guard()) { setNotice("Access changed. Try again."); return; }
      forumSoulNode(gun, forumStatementSoul(row.id))!.put({ [hop + "Forward"]: JSON.stringify([viewer, signature]) });
      setNotice("Waiting for the signed forward.");
    } catch { setNotice("Could not forward the report."); }
  }
  if (!valid(row) || !viewer || !graph.checkForumSee(row.id, viewer, now).allowed ||
      !graph.checkForumSee(path.squad.forumId, viewer, now).allowed || (level !== "squad" && (!fleetAccepted || !canReadHop(graph, path, level, row, viewer, now))) ||
      (level === "command" && (!command || !writerAllowed(command.signer, "command", now)))) return null;
  return <li className="space-y-1">
    <p className="text-xs text-ink-muted">{shortSea(row.author)} · {formatClock(row.ts)}</p>
    <p className="break-words">{row.body}</p>
    {level !== "command" && (signed ? <span>Forwarded to {hop === "fleet" ? "Fleet" : "Command"}</span> :
      <button type="button" className={btnSecondary} disabled={!maySend()} onClick={() => void send()}>
        Send to {hop === "fleet" ? "Fleet" : "Command"}
      </button>)}
    {notice && !signed && <p role="status">{notice}</p>}
  </li>;
}

export function LiveForumReports(props: Props) {
  const [level, setLevel] = useState<"squad" | ForwardHop>("squad");
  return <section aria-label="Reports" className="space-y-3 border border-rule p-4">
    <h2 className="font-semibold">Reports</h2>
    <nav aria-label="Report destination" className="flex gap-2">
      {(["squad", "fleet", "command"] as const).map(id =>
        <button type="button" className={btnSecondary} key={id} aria-pressed={level === id}
          onClick={() => setLevel(id)}>{id === "squad" ? "Squad" : id === "fleet" ? "Fleet" : "Command"}</button>)}
    </nav>
    <ul className="space-y-2 empty:hidden">{props.reports.map(row =>
      <LiveReport key={reportRevision(row)} {...props} row={row} level={level} />)}</ul>
    <p className="hidden text-sm text-ink-muted [ul:empty+&]:block">No readable reports here yet.</p>
  </section>;
}
