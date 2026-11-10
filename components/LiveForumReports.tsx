"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FeedGun } from "./GunPeerProvider";
import type { ForumAuthorityGraph } from "@/lib/identity/forum-authority";
import { forumNeedSoul, forumStatementSoul } from "@/lib/identity/forum-check";
import type { SeaPair } from "@/lib/identity/sea";
import { forumSoulNode } from "@/lib/forum-transport";
import { readForumSignature, signForumRecord } from "@/lib/forum-sign";
import { canForward, canReadBoard, canReadHop, forwardStatement, signedForward, sourceRevision, isNeed,
  withdrawalStatement, type forwardFields, type BoardLevel, type BoardSource, type ReportPath, type ForwardHop } from "@/lib/forum-report-forward";
import { btnSecondary } from "@/lib/brand-ui";

type Fields = ReturnType<typeof forwardFields>;
type Props = {
  path: ReportPath; graph: ForumAuthorityGraph; gun: FeedGun; rows: BoardSource[];
  evidence: (row: BoardSource) => Fields | undefined;
  sessionKey: string; pair: () => SeaPair | null; valid: (row: BoardSource) => boolean;
  read: ReadonlySet<string>; markRead: (key: string) => void;
  reportsOnly: boolean; children?: React.ReactNode;
};
const names = { command: "Command", fleet: "Fleet", squad: "Squad" };
const levels = ["command", "fleet", "squad"] as const;
const clock = () => Math.floor(Date.now() / 1000);
const proofId = (key: string, sig: string) => JSON.stringify([key, sig]);

// Cache only signature decoding. Authority, paths, source revisions and withdrawal
// bindings are checked against the current graph on every projection and write.
function useSignatures(keys: string) {
  const [decoded, setDecoded] = useState(new Map<string, unknown>());
  const cache = useRef(new Map<string, Promise<unknown>>());
  useEffect(() => {
    let active = true;
    const ids: string[] = JSON.parse(keys);
    const next = new Map<string, Promise<unknown>>();
    for (const id of ids) {
      const [key, sig] = JSON.parse(id);
      next.set(id, cache.current.get(id) ?? readForumSignature(sig, key).catch(() => null));
    }
    cache.current = next;
    void Promise.all([...next].map(async ([id, value]) => [id, await value] as const)).then(pairs => {
      if (active) setDecoded(new Map(pairs));
    });
    return () => { active = false; };
  }, [keys]);
  return decoded;
}

export function LiveForumReports(props: Props) {
  const { graph, path, sessionKey } = props;
  const [selected, setLevel] = useState<BoardLevel>("squad");
  const { read } = props;
  const [notice, setNotice] = useState("");
  const now = clock();
  const viewer = graph.principalForKey(sessionKey, now);
  const sources = props.rows.filter(row => viewer && props.valid(row) && canReadHop(graph, path, "squad", row, viewer, now));
  const proofs = new Set<string>();
  for (const row of sources) {
    for (const wire of Object.values(props.evidence(row) ?? {})) {
      const key = wire && graph.writerKey(wire.signer, now, now);
      if (wire && key) proofs.add(proofId(key, wire.sig));
    }
  }
  const decoded = useSignatures(JSON.stringify([...proofs].sort()));
  function payload(wire: Fields["fleet"], at: number) {
    const key = wire && graph.writerKey(wire.signer, at, at);
    return wire && key ? decoded.get(proofId(key, wire.sig)) : undefined;
  }
  function accepted(row: BoardSource, hop: ForwardHop, parent: string | null, at: number) {
    const fields = props.evidence(row), forward = fields?.[hop];
    if (!forward || !canForward(graph, path, hop, row, forward.signer, at)) return null;
    const statement = forwardStatement(path, hop, row, parent);
    if (payload(forward, at) !== signedForward(statement, forward.signer)) return null;
    const withdrawal = fields?.[hop === "fleet" ? "fleetWithdrawal" : "commandWithdrawal"];
    if (withdrawal && withdrawal.signer === forward.signer) {
      const text = payload(withdrawal, at);
      if (text === undefined || text === signedForward(withdrawalStatement(statement, forward.sig), withdrawal.signer)) return null;
    }
    return forward;
  }
  function hops(row: BoardSource, at: number) {
    const fleet = accepted(row, "fleet", null, at);
    return { fleet, command: fleet && accepted(row, "command", fleet.sig, at) };
  }
  const boards = levels.filter(id => viewer && canReadBoard(graph, path, id, viewer, now));
  const level = boards.includes(selected) ? selected : "squad";
  const projected = sources.map(row => ({ row, ...hops(row, now), revision: sourceRevision(row) }));
  const visibleAt = (id: BoardLevel) => projected.filter(entry => viewer && canReadHop(graph, path, id, entry.row, viewer, now) &&
    (id === "squad" || entry[id]));
  const visible = visibleAt(level);
  const readKey = (id: BoardLevel, revision: string) => JSON.stringify([sessionKey, path[id].forumId, revision]);
  function action(row: BoardSource, hop: ForwardHop, at: number) {
    if (!viewer || graph.principalForKey(sessionKey, at) !== viewer || props.pair()?.pub !== sessionKey ||
        !props.valid(row) || !canForward(graph, path, hop, row, viewer, at)) return null;
    const current = hops(row, at);
    if (hop === "command" && !current.fleet) return null;
    const statement = forwardStatement(path, hop, row, hop === "command" ? current.fleet!.sig : null);
    const previous = current[hop];
    if (previous && previous.signer !== viewer) return null;
    return { field: hop + (previous ? "Withdrawal" : "Forward"),
      text: signedForward(previous ? withdrawalStatement(statement, previous.sig) : statement, viewer) };
  }
  const latest = useRef(action);
  useLayoutEffect(() => { latest.current = action; return () => { latest.current = () => null; }; });
  async function send(row: BoardSource, hop: ForwardHop) {
    const decision = latest.current(row, hop, clock()), pair = props.pair();
    if (!decision || !pair) return;
    try {
      const sig = await signForumRecord(decision.text, pair);
      if (!sig || latest.current(row, hop, clock())?.text !== decision.text) { setNotice("Access or source changed."); return; }
      const soul = isNeed(row) ? forumNeedSoul(row.forumId, row.id) : forumStatementSoul(row.id);
      forumSoulNode(props.gun, soul)!.put({ [decision.field]: JSON.stringify([viewer, sig]) });
      setNotice("Waiting for the signed update.");
    } catch { setNotice("Could not send the signed update."); }
  }
  return <>{boards.length > 0 && <section aria-label={props.reportsOnly ? "Reports" : "Forum hierarchy"} className="space-y-3 border border-rule p-4">
    <nav aria-label="Report destination" className="flex flex-wrap gap-2">
      {boards.map(id => {
        const entries = visibleAt(id), needs = entries.filter(e => isNeed(e.row));
        return <div key={id}><button type="button" className={btnSecondary} aria-pressed={level === id}
          onClick={() => { setLevel(id); setNotice(""); }}>{names[id]}</button>
          {!props.reportsOnly && <p aria-label={names[id] + " badges"} className="text-xs">
            {entries.filter(e => !isNeed(e.row) && !read.has(readKey(id, e.revision))).length} unread · {needs.length} needs · {needs.filter(e => isNeed(e.row) && e.row.severity === "emergency").length} emergency
          </p>}</div>;
      })}
    </nav>
    <h2 className="font-semibold">{props.reportsOnly ? "Reports" : level === "command" ? "Command priorities" : level === "fleet" ? "Fleet situation" : "Squad updates"}</h2>
    <ul className="space-y-2">{visible.map(({row, revision, fleet, command}) => {
      const hop = level === "squad" ? "fleet" : "command";
      const forwarded = hop === "fleet" ? fleet : command;
      const permitted = level !== "command" && action(row, hop, now);
      const key = readKey(level, revision);
      return <li key={revision}>
        {isNeed(row) && <strong>{row.severity === "emergency" ? "Emergency" : "Needs help"}</strong>}
        <p className="break-words">{row.body}</p>
        {!isNeed(row) && !props.reportsOnly && !read.has(key) && <button type="button" className={btnSecondary}
          onClick={() => props.markRead(key)}>Mark read</button>}
        {level !== "command" && forwarded && <span>Forwarded to {names[hop]}</span>}
        {permitted && <button type="button" className={btnSecondary} onClick={() => void send(row, hop)}>
          {forwarded ? "Withdraw from" : isNeed(row) ? "Escalate to" : "Send to"} {names[hop]}
        </button>}
      </li>;
    })}</ul>
    {!visible.length && <p>{props.reportsOnly ? "No readable reports here yet." : "No readable updates here yet."}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>}{selected === "squad" && props.children}</>;
}
