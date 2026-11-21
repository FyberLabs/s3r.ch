import { createHash } from "node:crypto";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { isSeaPubkey } from "./identity/forum-check";
import { matchesBrowserOrigin } from "./request-origin";
import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import type { LiveSquadSpec } from "./squad-view";

const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export type SquadPlaneConfig = Readonly<{ origin: string; tenant: string; roster: Readonly<Record<string, string>>; controlCredential?: string }>;

export function parseSquadPlaneConfig(value: unknown): SquadPlaneConfig {
  if (!record(value) || !["origin,roster,tenant", "controlCredential,origin,roster,tenant"].includes(
      Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join()) ||
      ("controlCredential" in value && (typeof value.controlCredential !== "string" ||
        !/^hm_fop_[a-f0-9]{64}$/.test(value.controlCredential))) ||
      typeof value.origin !== "string" || !value.origin.startsWith("https://") ||
      new URL(value.origin).origin !== value.origin || !uuid(value.tenant) || !record(value.roster)) {
    throw Error("Invalid squad Plane configuration");
  }
  const entries = Object.entries(value.roster);
  if (entries.length === 0 || entries.length > 128 ||
      new Set(entries.map(([, principal]) => principal)).size !== entries.length ||
      !entries.every(([bot, principal]) => uuid(bot) && typeof principal === "string" && isSeaPubkey(principal))) {
    throw Error("Invalid squad Plane roster");
  }
  return { origin: value.origin, tenant: value.tenant, roster: value.roster as Record<string, string>,
    ...(typeof value.controlCredential === "string" ? { controlCredential: value.controlCredential } : {}) };
}

export function squadPlaneTaskId(tenant: string, forum: string, sourceTask: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["s3rch-forum-intent-v1", tenant, forum, sourceTask]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

type Action = "tasks" | "control";
type PlaneRequest = Action | "bot-controls";

function command(action: Action, json: unknown) {
  if (!record(json) || json.version !== 1 || !uuid(json.bot_id) || !uuid(json.source_task_id) ||
      !uuid(json.assignment_id) || !uuid(json.session_id)) return null;
  const { bot_id, source_task_id, assignment_id, session_id } = json;
  const keys = Object.keys(json).sort((left, right) => left.localeCompare(right, "en")).join();
  const scope = { version: 1, source_task_id, assignment_id, session_id };
  if (action === "control") {
    if (keys === "assignment_id,bot_id,session_id,source_task_id,version") return { bot_id, scope };
    if (keys === "action,assignment_id,bot_id,session_id,source_task_id,version" &&
        (json.action === "pause" || json.action === "resume")) return { bot_id, scope: { ...scope, action: json.action } };
    return null;
  }
  if (keys === "assignment_id,bot_id,kind,request_sha256,session_id,source_task_id,version" &&
      json.kind === "remote-agent" && typeof json.request_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(json.request_sha256)) {
    return { bot_id, scope: { ...scope, kind: json.kind, request_sha256: json.request_sha256 } };
  }
  if (keys === "assignment_id,bot_id,kind,session_id,source_task_id,submission_base64,version,workspace" &&
      json.kind === "local" && typeof json.workspace === "string" && json.workspace.length >= 2 &&
      json.workspace.length <= 4096 && typeof json.submission_base64 === "string" &&
      json.submission_base64.length <= 64000 && /^[A-Za-z0-9+/]+={0,2}$/.test(json.submission_base64)) {
    return { bot_id, scope: { ...scope, kind: json.kind, workspace: json.workspace, submission_base64: json.submission_base64 } };
  }
  return null;
}

export function createSquadPlaneForum(input: {
  siteOrigin: string;
  squad: LiveSquadSpec;
  plane: SquadPlaneConfig;
  config: ForumAuthorityConfig;
  authenticate(request: Request): Promise<{ key: string } | null>;
  read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot>;
  clock?: () => number;
  fetch?: typeof fetch;
}) {
  const site = new URL(input.siteOrigin);
  const squad = structuredClone(input.squad);
  const plane = parseSquadPlaneConfig(structuredClone(input.plane));
  const config = structuredClone(input.config);
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const send = input.fetch ?? fetch;
  const reply = (status: number, body?: object) =>
    Response.json(body ?? { error: "forum-agent-request-refused" }, { status, headers: { "Cache-Control": "no-store" } });

  async function ownerGraph(key: string, signal: AbortSignal) {
    const at = clock();
    const snapshot = await input.read(at, signal);
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 1024) throw Error("Forum authority unavailable");
    const authority = createForumAuthority(config, clock);
    const verified = await authority.refresh(snapshot, at);
    if (!verified.ok || clock() !== at || roomAuthorityReadDiagnosticsBlock(verified.diagnostics, snapshot) ||
        authority.graph.ownerOf(squad.forumId) !== squad.owner) throw Error("Forum authority unavailable");
    return authority.graph.principalForKey(key, at) === squad.owner ? { graph: authority.graph, at } : null;
  }

  function post(botId: string, path: string, credential: string, body: object, signal: AbortSignal) {
    return send(new URL(`/api/v1/hypermesh/bots/${botId}/forum/${path}`, plane.origin), {
      method: "POST", redirect: "error", cache: "no-store", signal,
      headers: { Authorization: credential, "Content-Type": "application/json", "X-Tenant-ID": plane.tenant },
      body: JSON.stringify(body),
    });
  }

  async function browserControl(body: unknown, key: string, signal: AbortSignal) {
    if (!plane.controlCredential) return reply(404);
    if (!record(body) || body.version !== 1 ||
        Object.keys(body).some(field => !["version", "bot_id", "action"].includes(field)) ||
        (body.action !== undefined && body.action !== "pause" && body.action !== "resume")) return reply(400);
    const current = await ownerGraph(key, signal);
    if (!current) return reply(403);
    const eligible = Object.entries(plane.roster).filter(([, principal]) =>
      current.graph.checkForumSee(squad.forumId, principal, current.at).allowed &&
      current.graph.checkPost(squad.forumId, principal, current.at).allowed);
    if (body.bot_id === undefined) {
      return body.action === undefined ? reply(200, { bots: eligible.map(([id, principal]) => ({ id, principal })) }) : reply(400);
    }
    const match = eligible.find(([id]) => id === body.bot_id);
    if (!match) return reply(403);
    const [id, principal] = match;
    const response = await post(id, "control-current", "Bearer " + plane.controlCredential,
      { version: 1, forum_id: squad.forumId, principal, action: body.action }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      return reply(response.status === 409 ? 409 : 503);
    }
    const fact = await readBoundedIdentityJson(response, 4096, signal);
    if (!record(fact) || fact.version !== 1 || fact.tenant_id !== plane.tenant ||
        fact.bot_id !== id || !record(fact.forum) || fact.forum.id !== squad.forumId ||
        fact.forum.principal !== principal ||
        (fact.desired !== "running" && fact.desired !== "paused" && fact.desired !== "stopped") ||
        (body.action === "pause" && fact.desired !== "paused") ||
        (body.action === "resume" && fact.desired !== "running")) return reply(503);
    return reply(200, { desired: fact.desired });
  }

  return async (request: Request, action: PlaneRequest) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const credential = request.headers.get("Authorization");
    if (request.method !== "POST" || !matchesBrowserOrigin(request, site) ||
        request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return reply(403);

    try {
      const session = await input.authenticate(request);
      if (!session) return reply(403);
      let body;
      try { body = await readBoundedIdentityJson(new Response(request.body), action === "bot-controls" ? 1024 : 90000, signal); }
      catch { return reply(400); }
      if (action === "bot-controls") return await browserControl(body, session.key, signal);
      if (!credential || credential.length > 8192 || !/^Bearer [A-Za-z0-9._~-]+$/.test(credential)) return reply(403);
      const parsed = command(action, body);
      if (!parsed) return reply(400);
      const principal = plane.roster[parsed.bot_id];
      if (!principal) return reply(403);

      const current = await ownerGraph(session.key, signal);
      if (!current ||
          !current.graph.checkForumSee(squad.forumId, principal, current.at).allowed ||
          !current.graph.checkPost(squad.forumId, principal, current.at).allowed) return reply(403);

      const response = await post(parsed.bot_id, action, credential,
        { ...parsed.scope, forum_id: squad.forumId, ...(action === "tasks" ? { principal } : {}) }, signal);
      if (!response.ok) {
        await response.body?.cancel();
        return reply([401, 403, 404, 409, 422].includes(response.status) ? response.status : 503);
      }
      const fact = await readBoundedIdentityJson(response, 4096, signal);
      if (!record(fact) || fact.version !== 1 || fact.tenant_id !== plane.tenant ||
          fact.bot_id !== parsed.bot_id || fact.assignment_id !== parsed.scope.assignment_id ||
          fact.session_id !== parsed.scope.session_id ||
          fact.task_id !== squadPlaneTaskId(plane.tenant, squad.forumId, parsed.scope.source_task_id) ||
          !record(fact.forum) || fact.forum.id !== squad.forumId ||
          fact.forum.source_task_id !== parsed.scope.source_task_id || fact.forum.principal !== principal ||
          ("kind" in parsed.scope && fact.forum.kind !== parsed.scope.kind) ||
          ("action" in parsed.scope && fact.desired !== (parsed.scope.action === "pause" ? "paused" : "running")) ||
          typeof fact.desired !== "string" || !["paused", "running", "stopped"].includes(fact.desired) ||
          typeof fact.status !== "string" || !["queued", "delivered", "completed", "cancelled", "failed", "unknown"].includes(fact.status)) {
        return reply(503);
      }
      return reply(200, { taskId: fact.task_id, status: fact.status, desired: fact.desired });
    } catch {
      return reply(503);
    }
  };
}
