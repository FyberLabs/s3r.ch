"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGunPeer, type FeedGun } from "@/components/GunPeerProvider";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import {
  btnPrimary,
  btnSecondary,
  btnTabOff,
  btnTabOn,
  chipOff,
  chipOn,
  field,
} from "@/lib/brand-ui";
import { toGunNode, type FeedItem } from "@/lib/feed-types";
import {
  PILOT_AGENTS,
  PILOT_ALARM,
  PILOT_CHAT,
  PILOT_FORUM_ID,
  PILOT_FORUM_LABEL,
  PILOT_LABELS,
  PILOT_NEEDS,
  admitPilotRoster,
} from "@/lib/forum-squad-fixture";
import {
  chatAddresses,
  chatTone,
  clampProgress,
  canWriteStatus,
  filterAgents,
  formatClock,
  formatRuntime,
  formatTokens,
  forumStatementFromNode,
  mergeAgents,
  needIds,
  openNeedFor,
  overlaySeeGraph,
  parseForumAgentStatus,
  parseForumNeed,
  pausedStatus,
  reassignedStatus,
  shortSea,
  showFullVitals,
  buildForumStatement,
  type SquadAgent,
  type VitalsMode,
} from "@/lib/forum-squad";
import { browserGunOptions, listenThenConnectSeedPeer, type SeedPeerEmitter } from "@/lib/gun-peer";
import {
  admitFeedNode,
  forumAgentSoul,
  forumAlarmSoul,
  forumChatTag,
  forumEmergencyAlarm,
  forumNeedSoul,
  forumStatementSoul,
  isForumObjectId,
  isSeaPubkey,
  isSeparateChatSoul,
  resolveForumNeed,
  validateForumStatus,
  type ForumAgentState,
  type ForumAgentStatus,
  type ForumAlarm,
  type ForumNeed,
  type SeeGraph,
} from "@/lib/identity/check";
import { getMeshKey } from "@/lib/identity/idb";
import { createMemorySeeAcl } from "@/lib/identity/see-acl";

const STATES: ForumAgentState[] = ["emergency", "needs", "working", "idle"];

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stateDot(state: ForumAgentState): string {
  if (state === "emergency") return "bg-status-fail";
  if (state === "needs") return "bg-signal";
  if (state === "working") return "bg-status-pass";
  return "bg-ink-muted";
}

function chainGet(gun: FeedGun, soul: string): FeedGun | null {
  if (isSeparateChatSoul(soul)) return null;
  const parts = soul.split("/");
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return null;
  let node = gun;
  for (const part of parts) node = node.get(part);
  return node;
}

function putSoul(gun: FeedGun | null, soul: string, data: unknown): boolean {
  if (!gun) return false;
  const node = chainGet(gun, soul);
  if (!node) return false;
  node.put(data);
  return true;
}

function parseAlarm(value: unknown): ForumAlarm | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.pinned !== 1) return null;
  if (row.forumId !== PILOT_FORUM_ID) return null;
  if (typeof row.need !== "string" || !isForumObjectId(row.need, "need")) return null;
  return { forumId: PILOT_FORUM_ID, need: row.need, pinned: 1 };
}

function entropy(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ChatBody({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z][A-Za-z0-9-]{0,31})/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("@") && chatAddresses(part).length > 0 ? (
          <span key={`${index}-${part}`} className="font-semibold text-signal">
            {part}
          </span>
        ) : (
          <span key={`${index}-t`}>{part}</span>
        ),
      )}
    </>
  );
}

function authorLabel(pub: string): string {
  return PILOT_LABELS.get(pub) ?? shortSea(pub);
}

export function SquadForum() {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const gunPeer = useGunPeer();
  const register = gunPeer?.register;
  const [seaPub, setSeaPub] = useState<string | null>(null);
  const [oauthLinked, setOauthLinked] = useState(false);
  const [vitals, setVitals] = useState<VitalsMode>("auto");
  const [tab, setTab] = useState<"board" | "chat">("board");
  const [filters, setFilters] = useState<Set<ForumAgentState>>(() => new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [reassignTo, setReassignTo] = useState("");
  const [meshStatus, setMeshStatus] = useState<Map<string, ForumAgentStatus>>(() => new Map());
  const [meshNeeds, setMeshNeeds] = useState<Map<string, ForumNeed>>(() => new Map());
  const [meshAlarm, setMeshAlarm] = useState<ForumAlarm | null>(null);
  const [alarmHeard, setAlarmHeard] = useState(false);
  const [meshChat, setMeshChat] = useState<FeedItem[]>([]);
  const [localStatus, setLocalStatus] = useState<Map<string, ForumAgentStatus>>(() => new Map());
  const [localNeeds, setLocalNeeds] = useState<Map<string, ForumNeed>>(() => new Map());
  const [localChat, setLocalChat] = useState<FeedItem[]>([]);
  const gunRef = useRef<FeedGun | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sampleAcl = useMemo(() => {
    const acl = createMemorySeeAcl();
    admitPilotRoster(acl);
    return acl;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!session?.address) {
      setSeaPub(null);
      return;
    }
    void getMeshKey(session.address)
      .then((record) => {
        if (cancelled) return;
        const pub = record?.seaPub;
        setSeaPub(pub && isSeaPubkey(pub) ? pub : null);
      })
      .catch(() => {
        if (!cancelled) setSeaPub(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.address]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/identity/oauth/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return false;
        const body = (await response.json()) as { linked?: unknown };
        return body.linked === true;
      })
      .then((linked) => {
        if (!cancelled) setOauthLinked(linked);
      })
      .catch(() => {
        if (!cancelled) setOauthLinked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!register) return;
    let cancelled = false;
    let offAgents: { off?: () => void } | undefined;
    let offNeeds: { off?: () => void } | undefined;
    let offAlarm: { off?: () => void } | undefined;
    let offItems: { off?: () => void } | undefined;

    void (async () => {
      const GunMod = await import("gun/browser");
      const Gun = (GunMod.default ?? GunMod) as unknown as (opts?: object) => FeedGun;
      if (cancelled) return;
      const gun = Gun(browserGunOptions());
      gunRef.current = gun;
      register(gun);
      listenThenConnectSeedPeer(gun as unknown as SeedPeerEmitter, window.location.origin, () => {});
      const forum = gun.get("s3rch").get("forums").get(PILOT_FORUM_ID);
      offAgents = forum.get("agents").map().on((data) => {
        const status = parseForumAgentStatus(data);
        if (!status || status.forumId !== PILOT_FORUM_ID) return;
        setMeshStatus((prev) => {
          const next = new Map(prev);
          next.set(status.seaPubkey, status);
          return next;
        });
      });
      offNeeds = forum.get("needs").map().on((data) => {
        const need = parseForumNeed(data);
        if (!need || need.forumId !== PILOT_FORUM_ID) return;
        setMeshNeeds((prev) => {
          const next = new Map(prev);
          next.set(need.id, need);
          return next;
        });
      });
      offAlarm = forum.get("alarm").on((data) => {
        setAlarmHeard(true);
        setMeshAlarm(parseAlarm(data));
      });
      offItems = gun.get("s3rch").get("items").map().on((data) => {
        const item = forumStatementFromNode(data, PILOT_FORUM_ID);
        if (!item) return;
        setMeshChat((prev) => {
          if (prev.some((row) => row.id === item.id)) {
            return prev.map((row) => (row.id === item.id ? item : row));
          }
          return [...prev, item];
        });
      });
    })();

    return () => {
      cancelled = true;
      offAgents?.off?.();
      offNeeds?.off?.();
      offAlarm?.off?.();
      offItems?.off?.();
      gunRef.current = null;
      register(null);
    };
  }, [register]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const graph: SeeGraph | null = see ? overlaySeeGraph(see.acl, sampleAcl) : null;

  const needs = useMemo(() => {
    const map = new Map<string, ForumNeed>();
    for (const need of PILOT_NEEDS) map.set(need.id, need);
    for (const need of meshNeeds.values()) map.set(need.id, need);
    for (const need of localNeeds.values()) map.set(need.id, need);
    return map;
  }, [localNeeds, meshNeeds]);

  const roster = useMemo(() => {
    const merged = mergeAgents(PILOT_AGENTS, [...meshStatus.values()]);
    return merged.map((agent) => {
      const over = localStatus.get(agent.status.seaPubkey);
      return over ? { ...agent, status: over } : agent;
    });
  }, [localStatus, meshStatus]);

  const visible = useMemo(
    () => filterAgents(roster, filters, query),
    [filters, query, roster],
  );

  const alarm = meshAlarm ?? (alarmHeard ? null : PILOT_ALARM);
  const pinnedNeed = alarm ? (needs.get(alarm.need) ?? null) : null;
  const alarmOn = forumEmergencyAlarm(
    roster.map((agent) => agent.status.state),
    alarm,
    pinnedNeed,
  );
  const emergencyCount = roster.filter((agent) => agent.status.state === "emergency").length;
  const needsCount = roster.filter((agent) => agent.status.state === "needs").length;
  const active = roster.find((agent) => agent.status.seaPubkey === selected) ?? null;

  const chat = useMemo(() => {
    const map = new Map<string, FeedItem>();
    for (const item of PILOT_CHAT) map.set(item.id, item);
    for (const item of meshChat) map.set(item.id, item);
    for (const item of localChat) map.set(item.id, item);
    return [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }, [localChat, meshChat]);

  const requireGraph = useCallback((): SeeGraph | null => {
    if (!see?.ready || !graph) {
      setNotice("Check is still loading.");
      return null;
    }
    if (!seaPub) {
      setNotice("A SEA key on this browser is required.");
      return null;
    }
    return graph;
  }, [graph, seaPub, see?.ready]);

  function toggleFilter(state: ForumAgentState) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  }

  function onResolve(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    const open = openNeedFor(agent.status, needs);
    if (!open) {
      setNotice("No open need on this tile.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const decision = resolveForumNeed({
      graph: current,
      writer: seaPub,
      need: open,
      now,
    });
    if (!decision.ok) {
      setNotice(`Check denied resolve (${decision.reason}).`);
      return;
    }
    setLocalNeeds((prev) => {
      const next = new Map(prev);
      next.set(decision.need.id, decision.need);
      return next;
    });
    const soul = forumNeedSoul(decision.need.forumId, decision.need.id);
    const wrote = putSoul(gunRef.current, soul, decision.need);
    setNotice(wrote ? "Need resolved." : "Need resolved on this browser. The mesh peer was not ready.");
  }

  function onReply(agent: SquadAgent) {
    setDraft(`@${agent.label} `);
    setTab("chat");
    setNotice("");
    queueMicrotask(() => composerRef.current?.focus());
  }

  function onPause(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    if (!canWriteStatus(current.ownerOf(agent.status.id), seaPub)) {
      setNotice("Check see is not a status write. The admitted owner can write status.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const next = pausedStatus(agent.status, now);
    if (!validateForumStatus(next)) {
      setNotice("Status was not accepted.");
      return;
    }
    setLocalStatus((prev) => {
      const map = new Map(prev);
      map.set(next.seaPubkey, next);
      return map;
    });
    const wrote = putSoul(gunRef.current, forumAgentSoul(next.forumId, next.seaPubkey), next);
    setNotice(wrote ? "Paused." : "Paused on this browser. The mesh peer was not ready.");
  }

  function onReassign(agent: SquadAgent) {
    const target = reassignTo.trim();
    if (!isSeaPubkey(target)) {
      setNotice("Enter a SEA pubkey to reassign.");
      return;
    }
    const current = requireGraph();
    if (!current || !seaPub) return;
    if (!canWriteStatus(current.ownerOf(agent.status.id), seaPub)) {
      setNotice("Check see is not a status write. The admitted owner can write status.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const next = reassignedStatus(agent.status, target, now);
    if (!next || !validateForumStatus(next)) {
      setNotice("Status was not accepted.");
      return;
    }
    setLocalStatus((prev) => {
      const map = new Map(prev);
      map.set(next.seaPubkey, next);
      return map;
    });
    const wrote = putSoul(gunRef.current, forumAgentSoul(next.forumId, next.seaPubkey), next);
    setNotice(wrote ? "Reassigned." : "Reassigned on this browser. The mesh peer was not ready.");
  }

  function onSend() {
    if (!see?.ready || !seaPub) {
      setNotice(seaPub ? "Check is still loading." : "A SEA key on this browser is required.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const item = buildForumStatement({
      forumId: PILOT_FORUM_ID,
      author: seaPub,
      body: draft,
      now,
      entropy: entropy(),
    });
    if (!item) {
      setNotice("Statement was not accepted.");
      return;
    }
    const node = toGunNode(item);
    const admitted = admitFeedNode(see.acl, node, seaPub);
    if ("denied" in admitted) {
      setNotice("Check denied the statement.");
      return;
    }
    let soul: string;
    try {
      soul = forumStatementSoul(item.id);
    } catch {
      setNotice("Statement was not accepted.");
      return;
    }
    const wrote = putSoul(gunRef.current, soul, node);
    void see.persist();
    setLocalChat((prev) => [...prev, item]);
    setDraft("");
    setNotice(wrote ? "Statement sent." : "Statement kept on this browser. The mesh peer was not ready.");
  }

  const wallet = session?.address
    ? `${session.address.slice(0, 6)}…${session.address.slice(-4)}`
    : "not linked";

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Squad forum</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {PILOT_FORUM_LABEL}. Identity is the SEA pubkey. Wallet and Panopticon are linked
            credentials.
          </p>
        </div>
        {alarmOn ? (
          <p
            data-testid="squad-alarm"
            className="border border-status-fail bg-status-fail px-3 py-2 text-xs font-semibold text-ground"
          >
            Alarm
          </p>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-2 text-xs text-ink-muted sm:grid-cols-3">
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Identity</dt>
          <dd className="mt-1 font-data text-ink">{seaPub ? shortSea(seaPub) : "no SEA key on this browser"}</dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Wallet</dt>
          <dd className="mt-1 font-data text-ink" title={session?.address ?? ""}>
            {wallet}
          </dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Panopticon</dt>
          <dd className="mt-1 text-ink">{oauthLinked ? "linked" : "not linked"}</dd>
        </div>
      </dl>
      {!session ? (
        <p className="mt-2 text-sm text-ink-muted">
          <Link href="/feed" className="font-semibold text-ink hover:text-signal">
            Sign in on the feed
          </Link>{" "}
          to link a wallet. The SEA key stays on this browser.
        </p>
      ) : null}
      {notice ? (
        <p data-testid="squad-notice" className="mt-3 border border-rule bg-panel px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)_320px]">
        <aside className="border border-rule bg-panel p-3 text-sm">
          <p className="font-semibold text-ink">{PILOT_FORUM_LABEL}</p>
          <p className="mt-2 text-xs text-ink-muted">
            {emergencyCount} emergency · {needsCount} needs
          </p>
          <p className="mt-3 text-xs font-semibold text-ink">Vitals</p>
          <div data-testid="squad-vitals" className="mt-2 flex flex-wrap gap-1">
            {(["auto", "dot", "full"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={vitals === mode ? chipOn : chipOff}
                onClick={() => setVitals(mode)}
              >
                {mode === "auto" ? "Auto" : mode === "dot" ? "Dot" : "Full"}
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-ink-muted">Fleet and Command are not on this page.</p>
        </aside>

        <section>
          <div className="flex gap-2">
            <button
              type="button"
              className={tab === "board" ? btnTabOn : btnTabOff}
              onClick={() => setTab("board")}
            >
              Board
            </button>
            <button
              type="button"
              className={tab === "chat" ? btnTabOn : btnTabOff}
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
          </div>

          <div
            data-testid="squad-board"
            className={`mt-3 ${tab === "chat" ? "hidden lg:block" : ""}`}
          >
              <div className="flex flex-wrap items-center gap-2">
                {STATES.map((state) => (
                  <button
                    key={state}
                    type="button"
                    className={filters.has(state) ? chipOn : chipOff}
                    onClick={() => toggleFilter(state)}
                  >
                    {state}
                  </button>
                ))}
                <input
                  className={`${field} min-w-0 flex-1`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter tiles"
                  aria-label="Filter tiles"
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((agent) => {
                  const open = openNeedFor(agent.status, needs);
                  const full = showFullVitals(agent.status.type, vitals);
                  return (
                    <button
                      key={agent.status.seaPubkey}
                      type="button"
                      data-testid={`squad-tile-${slug(agent.label)}`}
                      className={`border bg-panel p-3 text-left ${
                        agent.status.state === "emergency" ? "border-status-fail" : "border-rule"
                      }`}
                      onClick={() => setSelected(agent.status.seaPubkey)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <span className={`inline-block size-2 ${stateDot(agent.status.state)}`} aria-hidden />
                          {agent.label}
                        </span>
                        <span className="text-xs uppercase text-ink-muted">{agent.status.type}</span>
                      </div>
                      <p className="mt-1 text-xs uppercase text-ink-muted">{agent.status.state}</p>
                      <p className="mt-2 text-sm text-ink">{agent.status.task}</p>
                      <p className="mt-1 text-xs text-ink-muted">{agent.status.result}</p>
                      <p className="mt-2 line-clamp-2 text-xs text-ink">{agent.status.lastPrompt}</p>
                      {open ? <p className="mt-2 text-xs text-ink">{open.body}</p> : null}
                      <div className="mt-2 h-1 bg-rule">
                        <div
                          className="h-1 bg-signal"
                          style={{ width: `${clampProgress(agent.status.progress)}%` }}
                        />
                      </div>
                      {full ? (
                        <p className="mt-2 font-data text-xs text-ink-muted">
                          hb {agent.status.hb ?? "—"} · batt {agent.status.batt ?? "—"} · link{" "}
                          {agent.status.link ?? "—"}
                        </p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
        </section>

        <div className={tab === "board" ? "hidden lg:block" : ""}>
          <ChatColumn
            chat={chat}
            draft={draft}
            setDraft={setDraft}
            onSend={onSend}
            composerRef={composerRef}
            seaLabel={seaPub ? shortSea(seaPub) : "no SEA key"}
          />
        </div>
      </div>

      {active ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={active.label}
          data-testid="squad-drawer"
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col overflow-y-auto border-l border-rule bg-ground p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-ink">{active.label}</h2>
              <p className="mt-1 text-xs uppercase text-ink-muted">
                {active.status.state} · {PILOT_FORUM_LABEL} · {active.status.type}
              </p>
            </div>
            <button type="button" className={btnSecondary} onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs text-ink-muted">
            <div>
              <dt>Started</dt>
              <dd className="font-data text-ink">{formatClock(active.status.started)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd className="font-data text-ink">{formatTokens(active.status.tokens)}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd className="font-data text-ink">{formatRuntime(active.status.runtime)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink">{active.status.task}</p>
          <div className="mt-2 h-1 bg-rule">
            <div className="h-1 bg-signal" style={{ width: `${clampProgress(active.status.progress)}%` }} />
          </div>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Subtasks</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {active.subtasks.map((task) => (
              <li key={task.id}>
                <span className="text-xs uppercase text-ink-muted">{task.state}</span> {task.label}
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Last prompt</h3>
          <p className="mt-1 text-sm text-ink">
            {active.status.lastPrompt}
            {active.promptBy ? <span className="text-ink-muted"> · {active.promptBy}</span> : null}
          </p>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Updates</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {active.updates.map((update) => (
              <li key={update.id}>
                <span className="font-data text-xs text-ink-muted">{formatClock(update.ts)}</span> {update.body}
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Results</h3>
          <p className="mt-1 text-sm text-ink">{active.status.result}</p>
          {active.artifactNote ? <p className="mt-1 text-xs text-ink-muted">{active.artifactNote}</p> : null}
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Needs</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {needIds(active.status.needs).map((id) => {
              const need = needs.get(id);
              if (!need) return null;
              return (
                <li key={id}>
                  {need.severity} · stated {need.stated} · {need.body}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            {active.status.state === "needs" || active.status.state === "emergency" ? (
              <button
                type="button"
                data-testid="squad-resolve"
                className={btnPrimary}
                onClick={() => onResolve(active)}
              >
                Resolve need
              </button>
            ) : null}
            <button type="button" data-testid="squad-reply" className={btnSecondary} onClick={() => onReply(active)}>
              Reply in chat
            </button>
            <button type="button" data-testid="squad-pause" className={btnSecondary} onClick={() => onPause(active)}>
              Pause
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              className={`${field} min-w-0 flex-1`}
              value={reassignTo}
              onChange={(event) => setReassignTo(event.target.value)}
              placeholder="SEA pubkey"
              aria-label="Reassign target"
              data-testid="squad-reassign-target"
            />
            <button
              type="button"
              data-testid="squad-reassign"
              className={btnSecondary}
              onClick={() => onReassign(active)}
            >
              Reassign
            </button>
          </div>
          <p className="mt-3 text-xs text-ink-muted">Tag {forumChatTag(PILOT_FORUM_ID)}</p>
        </div>
      ) : null}
    </div>
  );
}

function ChatColumn({
  chat,
  draft,
  setDraft,
  onSend,
  composerRef,
  seaLabel,
}: {
  chat: FeedItem[];
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  composerRef?: { current: HTMLTextAreaElement | null };
  seaLabel: string;
}) {
  return (
    <section data-testid="squad-chat" className="mt-3 flex h-[32rem] flex-col border border-rule bg-panel lg:mt-0">
      <h2 className="border-b border-rule px-3 py-2 text-sm font-semibold text-ink">Live chat</h2>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {chat.map((item) => {
          const tone = chatTone(item);
          const klass =
            tone === "emergency"
              ? "border-l-2 border-status-fail pl-2"
              : tone === "system"
                ? "text-ink-muted"
                : "";
          return (
            <li key={item.id} className={`text-sm text-ink ${klass}`}>
              <span className="font-data text-xs text-ink-muted">
                {formatClock(item.ts)} {authorLabel(item.author)}
              </span>
              <p>
                <ChatBody body={item.body} />
              </p>
            </li>
          );
        })}
      </ol>
      <form
        className="border-t border-rule p-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <label className="text-xs text-ink-muted" htmlFor="squad-composer">
          statement as {seaLabel}
        </label>
        <textarea
          id="squad-composer"
          ref={(node) => {
            if (composerRef) composerRef.current = node;
          }}
          className={`${field} mt-1 min-h-16 w-full`}
          value={draft}
          maxLength={280}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={`${btnPrimary} mt-2`}>
          Send
        </button>
      </form>
    </section>
  );
}
