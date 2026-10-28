/**
 * Local sample for the squad pilot. These rows are not written to Gun
 * until a Check-backed action puts one. Identity on each row is a SEA pubkey.
 */

import { GUN_PROTOCOL_V, type FeedItem } from "@/lib/feed-types";
import {
  forumChatTags,
  isSeaPubkey,
  seaToPrincipalKey,
  validateForumStatus,
  type ForumAgentState,
  type ForumAgentStatus,
  type ForumAlarm,
  type ForumNeed,
  type SeeAcl,
} from "@/lib/identity/check";
import vector from "@/lib/identity/vectors/forums.json";
import type { SquadAgent, SquadSubtask, SquadUpdate } from "@/lib/forum-squad";

// Public vectors are demonstration identities, never live authority.
export const PILOT_MESH_ENABLED: boolean = false;
export const PILOT_FORUM_ID = vector.forumId;
export const PILOT_OWNER = vector.seaPubkey;
export const PILOT_FORUM_LABEL = "Squad 3";

const T0 = 1_762_000_000;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function seaFrom(n: number): string {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  x[0] = n;
  y[0] = 255 - n;
  x[31] = 3;
  y[31] = 7;
  return `${b64url(x)}.${b64url(y)}`;
}

function mint(kind: string, sea: string, n: number): string {
  const key = seaToPrincipalKey(sea);
  if (!key) throw new Error("bad-principal");
  return `${kind}_${key}_${n.toString(16).padStart(32, "0")}`;
}

type NeedDraft = { severity: "need" | "emergency"; body: string };

type Draft = {
  label: string;
  sea: string;
  state: ForumAgentState;
  type: string;
  task: string;
  result: string;
  progress: number;
  lastPrompt: string;
  promptBy: string;
  tokens: number;
  runtime: number;
  need?: NeedDraft;
  statusId?: string;
  needId?: string;
  hb?: number;
  batt?: number;
  link?: number;
  artifactNote: string;
  subtasks: Array<[string, SquadSubtask["state"]]>;
  updates: Array<[number, string]>;
};

const pubs = [
  vector.seaPubkey,
  vector.secondPubkey,
  seaFrom(3),
  seaFrom(4),
  seaFrom(5),
  seaFrom(6),
  seaFrom(7),
  seaFrom(8),
  seaFrom(9),
  seaFrom(10),
  seaFrom(11),
  seaFrom(12),
];

if (!pubs.every((pub) => isSeaPubkey(pub))) {
  throw new Error("bad-principal");
}

const drafts: Draft[] = [
  {
    label: "HAWK-2",
    sea: pubs[0],
    state: "emergency",
    type: "agent",
    task: "deploy rollback",
    result: "FAILED · error rate 38%",
    progress: 99,
    lastPrompt: "rollback failed on step 3/5 — awaiting authorization",
    promptBy: "PM",
    tokens: 41_000,
    runtime: 58 * 60,
    need: { severity: "emergency", body: "human ack + rollback auth" },
    statusId: vector.statusId,
    needId: vector.needId,
    artifactNote: "incident #42 · logs.txt · diff",
    subtasks: [
      ["snapshot current release", "done"],
      ["drain traffic from canary", "done"],
      ["restore previous build (step 3)", "failed"],
      ["verify health checks", "pending"],
      ["post report to Fleet ARGUS", "pending"],
    ],
    updates: [
      [8 * 60, "holding"],
      [5 * 60, "rollback failed on step 3/5"],
      [40 * 60, "error rate 38% detected"],
    ],
  },
  {
    label: "ORCA",
    sea: pubs[1],
    state: "needs",
    type: "agent",
    task: "R-14 schema migration",
    result: "draft PR ready",
    progress: 64,
    lastPrompt: "PR opened, 3 files, tests green",
    promptBy: "PM",
    tokens: 63_000,
    runtime: 90 * 60,
    need: { severity: "need", body: "review from PM" },
    artifactNote: "PR #31 · migration.sql · dry-run.log",
    subtasks: [
      ["write migration", "done"],
      ["backfill script", "done"],
      ["tests green", "done"],
      ["PM review", "running"],
      ["apply to staging", "pending"],
    ],
    updates: [
      [5 * 60, "PR opened, 3 files"],
      [20 * 60, "backfill dry-run OK"],
    ],
  },
  {
    label: "LYNX",
    sea: pubs[2],
    state: "needs",
    type: "agent",
    task: "dataset crawl",
    result: "paused at 72%",
    progress: 72,
    lastPrompt: "budget exhausted, requested top-up",
    promptBy: "PM",
    tokens: 160_000,
    runtime: 160 * 60,
    need: { severity: "need", body: "+40k tokens (Treasurer)" },
    artifactNote: "crawl-partial.jsonl",
    subtasks: [
      ["seed URL list", "done"],
      ["crawl 72% (paused)", "running"],
      ["dedupe", "pending"],
      ["hand to WREN for indexing", "pending"],
    ],
    updates: [[2 * 60, "budget exhausted, requested +40k"]],
  },
  {
    label: "KESTREL",
    sea: pubs[3],
    state: "working",
    type: "agent",
    task: "refactor auth module",
    result: "tests 118/140",
    progress: 84,
    lastPrompt: "fixing token refresh edge case",
    promptBy: "PM",
    tokens: 88_000,
    runtime: 2 * 3600,
    artifactNote: "branch auth-refactor",
    subtasks: [
      ["map auth call sites", "done"],
      ["extract session module", "done"],
      ["token refresh edge case", "running"],
      ["remove old path", "pending"],
    ],
    updates: [[9 * 60, "84%, no blockers"]],
  },
  {
    label: "MOTH",
    sea: pubs[4],
    state: "working",
    type: "agent",
    task: "summarize meeting",
    result: "notes → Secretary",
    progress: 40,
    lastPrompt: "summarize standup, flag decisions",
    promptBy: "Secretary",
    tokens: 9_000,
    runtime: 15 * 60,
    artifactNote: "draft notes",
    subtasks: [
      ["ingest transcript", "done"],
      ["extract decisions", "running"],
      ["send notes to Secretary", "pending"],
    ],
    updates: [[2 * 60, "2 decisions found"]],
  },
  {
    label: "VOLE",
    sea: pubs[5],
    state: "working",
    type: "agent",
    task: "R-15 spike",
    result: "prototype",
    progress: 22,
    lastPrompt: "benchmarking two cache layouts",
    promptBy: "PM",
    tokens: 27_000,
    runtime: 40 * 60,
    artifactNote: "bench-A.csv",
    subtasks: [
      ["layout A bench", "done"],
      ["layout B bench", "running"],
      ["write recommendation", "pending"],
    ],
    updates: [[1 * 60, "layout A p95 41ms"]],
  },
  {
    label: "You",
    sea: pubs[6],
    state: "needs",
    type: "user",
    task: "approving R-13",
    result: "awaiting",
    progress: 50,
    lastPrompt: "hold R-13 until eval done",
    promptBy: "PM",
    tokens: 0,
    runtime: 72 * 60,
    need: { severity: "need", body: "decision on scope" },
    artifactNote: "decision D-88",
    subtasks: [
      ["read R-13 eval", "done"],
      ["decide scope", "running"],
    ],
    updates: [[4 * 60, "told HAWK-2 to hold"]],
  },
  {
    label: "IBIS",
    sea: pubs[7],
    state: "working",
    type: "agent",
    task: "eval: skill retry",
    result: "score 0.91",
    progress: 91,
    lastPrompt: "scoring run 9/10",
    promptBy: "Practice Mgr",
    tokens: 52_000,
    runtime: 70 * 60,
    artifactNote: "eval-retry.json",
    subtasks: [
      ["build eval set", "done"],
      ["scoring run 9/10", "running"],
      ["publish score", "pending"],
    ],
    updates: [[0, "run 9/10"]],
  },
  {
    label: "WREN",
    sea: pubs[8],
    state: "working",
    type: "agent",
    task: "doc index",
    result: "412 nodes linked",
    progress: 66,
    lastPrompt: "linked Incident #41 → Decision log",
    promptBy: "Secretary",
    tokens: 12_000,
    runtime: 3600,
    artifactNote: "memory map diff",
    subtasks: [
      ["scan new docs", "done"],
      ["link nodes", "running"],
      ["report to Secretary", "pending"],
    ],
    updates: [[6 * 60, "linked Incident #41"]],
  },
  {
    label: "NEWT",
    sea: pubs[9],
    state: "working",
    type: "agent",
    task: "onboarding (new)",
    result: "module 3/5",
    progress: 60,
    lastPrompt: "reading Secretary brief: roadmap",
    promptBy: "Secretary",
    tokens: 19_000,
    runtime: 70 * 60,
    artifactNote: "onboarding checklist",
    subtasks: [
      ["module 1 forum basics", "done"],
      ["module 2 roles", "done"],
      ["module 3 roadmap", "running"],
      ["modules 4–5", "pending"],
    ],
    updates: [[1 * 60, "module 3 started"]],
  },
  {
    label: "ROVER-1",
    sea: pubs[10],
    state: "working",
    type: "robot",
    task: "site survey path",
    result: "waypoint 7/12",
    progress: 58,
    lastPrompt: "waypoint 7 reached",
    promptBy: "Rover team",
    tokens: 6_000,
    runtime: 100 * 60,
    hb: 1,
    batt: 64,
    link: 71,
    artifactNote: "survey tiles 1–7",
    subtasks: [
      ["waypoints 1–6", "done"],
      ["waypoint 7 to 8", "running"],
      ["waypoints 9–12", "pending"],
      ["upload survey", "pending"],
    ],
    updates: [[7 * 60, "waypoint 7 reached · batt 64%"]],
  },
  {
    label: "SABLE",
    sea: pubs[11],
    state: "idle",
    type: "agent",
    task: "—",
    result: "last: R-12",
    progress: 0,
    lastPrompt: "R-12 delivered, idle",
    promptBy: "PM",
    tokens: 0,
    runtime: 0,
    artifactNote: "R-12 release notes",
    subtasks: [["R-12 delivered", "done"]],
    updates: [[40 * 60, "idle, awaiting task"]],
  },
];

let nonce = 0x40;

function nextNonce(): number {
  nonce += 1;
  return nonce;
}

function build(draft: Draft, index: number): { agent: SquadAgent; need: ForumNeed | null } {
  const needId = draft.needId ?? (draft.need ? mint("need", draft.sea, nextNonce()) : "");
  const statusId = draft.statusId ?? mint("status", draft.sea, nextNonce());
  const subtasks: SquadSubtask[] = draft.subtasks.map(([label, state]) => ({
    id: mint("status", draft.sea, nextNonce()),
    label,
    state,
  }));
  const updates: SquadUpdate[] = draft.updates.map(([ago, body]) => ({
    id: mint("status", draft.sea, nextNonce()),
    ts: T0 - ago,
    body,
  }));
  const status: ForumAgentStatus = {
    id: statusId,
    forumId: PILOT_FORUM_ID,
    seaPubkey: draft.sea,
    task: draft.task,
    result: draft.result,
    needs: needId,
    progress: draft.progress,
    state: draft.state,
    lastPrompt: draft.lastPrompt,
    lastUpdate: T0 - (draft.updates[0]?.[0] ?? 0),
    type: draft.type,
    started: T0 - draft.runtime,
    tokens: draft.tokens,
    runtime: draft.runtime,
    ...(draft.hb !== undefined ? { hb: draft.hb } : {}),
    ...(draft.batt !== undefined ? { batt: draft.batt } : {}),
    ...(draft.link !== undefined ? { link: draft.link } : {}),
    artifacts: "",
  };
  if (!validateForumStatus(status)) {
    throw new Error(`sample status ${index} failed validation`);
  }
  const need: ForumNeed | null = draft.need
    ? {
        id: needId,
        forumId: PILOT_FORUM_ID,
        subject: draft.sea,
        severity: draft.need.severity,
        body: draft.need.body,
        stated: 1,
        hamState: 1,
        ts: T0 - 60,
      }
    : null;
  return {
    agent: {
      label: draft.label,
      promptBy: draft.promptBy,
      artifactNote: draft.artifactNote,
      status,
      subtasks,
      updates,
    },
    need,
  };
}

const built = drafts.map((draft, index) => build(draft, index));

export const PILOT_AGENTS: SquadAgent[] = built.map((row) => row.agent);
export const PILOT_NEEDS: ForumNeed[] = built.flatMap((row) => (row.need ? [row.need] : []));

export const PILOT_ALARM: ForumAlarm = {
  forumId: PILOT_FORUM_ID,
  need: vector.needId,
  pinned: 1,
};

export const PILOT_LABELS: ReadonlyMap<string, string> = new Map(
  PILOT_AGENTS.map((agent) => [agent.status.seaPubkey, agent.label]),
);

type ChatDraft = {
  ago: number;
  sea: string;
  body: string;
  extras: string[];
  kind?: string;
};

const chatDrafts: ChatDraft[] = [
  { ago: 20 * 60, sea: pubs[4], body: "decision D-88 recorded: R-13 scope frozen", extras: [] },
  { ago: 17 * 60, sea: pubs[3], body: "auth refactor 84%, no blockers", extras: [] },
  {
    ago: 13 * 60,
    sea: pubs[10],
    body: "ROVER-1 joined from Rover team (shared view)",
    extras: ["notice"],
    kind: "notice",
  },
  { ago: 10 * 60, sea: pubs[2], body: "need +40k tokens to finish crawl → @Treasurer", extras: [] },
  { ago: 7 * 60, sea: pubs[1], body: "LYNX request queued, approve by 08:00", extras: [] },
  {
    ago: 5 * 60,
    sea: pubs[0],
    body: "EMERGENCY: rollback step 3 failed, need human auth",
    extras: ["emergency"],
  },
  { ago: 4 * 60, sea: pubs[6], body: "on it — @HAWK-2 hold, don't retry", extras: [] },
  { ago: 3 * 60, sea: pubs[1], body: "ORCA: R-14 PR under review, eval at 12:00", extras: [] },
  { ago: 2 * 60, sea: pubs[7], body: "published skill retry-backoff to Squad 3", extras: ["report"] },
  {
    ago: 0,
    sea: pubs[0],
    body: "holding. report attached",
    extras: ["emergency", "report"],
  },
];

function chatItem(draft: ChatDraft, index: number): FeedItem {
  const tags = forumChatTags(PILOT_FORUM_ID, draft.extras);
  if (!tags) throw new Error(`sample chat ${index}`);
  return {
    id: `stmt-${T0 - draft.ago}-c${index}`,
    source: "s3rch",
    kind: draft.kind ?? "statement",
    author: draft.sea,
    body: draft.body,
    ts: T0 - draft.ago,
    permalink: "",
    tags,
    provenance: "s3rch:forum-statement",
    v: GUN_PROTOCOL_V,
  };
}

export const PILOT_CHAT: FeedItem[] = chatDrafts.map(chatItem);

export function admitPilotRoster(acl: SeeAcl): void {
  acl.putObject(PILOT_FORUM_ID, PILOT_OWNER);
  for (const agent of PILOT_AGENTS) acl.putObject(agent.status.id, PILOT_OWNER);
  for (const need of PILOT_NEEDS) acl.putObject(need.id, PILOT_OWNER);
}
