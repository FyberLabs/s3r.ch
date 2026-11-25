import { readBoundedIdentityJson } from "./identity/bounded-json";
import { authenticateAgentRequest } from "./identity/site-agent-session-server";
import { createForumAuthority, type ForumAuthorityGraph, type ForumAuthoritySnapshot, type ForumAuthorityConfig } from "./identity/forum-authority";
import { matchesBrowserOrigin, matchesRequestOrigin } from "./request-origin";
import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { RecordConflict } from "./record-store";
import { ArtifactRefusal } from "./squad-artifact";
import { handlePreviewAction, previewReadAction } from "./squad-preview";
import { handleWorkbookAction, isWorkbookAction, workbookReadAction } from "./squad-workbook";
import { briefReadAction, handleBriefAction, isBriefAction } from "./squad-brief-editor";
import { isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";
import { parseSquadPlaneCommand, type SquadPlaneConfig, type createSquadPlaneForum } from "./squad-plane-forum";
import {
  isProjectLabel, latestProjectDelegation, projectBoard, projectBranch, projectDigest, projectUuid,
  type createSquadProjectStore, type ProjectDelegation, type ProjectTask, type SquadProject,
} from "./squad-project";

type Agent = { agent: string; principal: string; delegationId: string };
type Actor = { principal: string; graph: ForumAuthorityGraph; at: number; agent: boolean };
const artifactReadAction = (action: unknown) => briefReadAction(action) || workbookReadAction(action) || previewReadAction(action);
const nativeRead = (request: Request, action: string) =>
  action === "resume" || (artifactReadAction(action) && request.headers.has("authorization"));
class ProjectRefusal extends Error {
  constructor(readonly status: number, readonly reason: string) { super(reason); }
}
const refuse = (status: number, reason: string): never => { throw new ProjectRefusal(status, reason); };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const sameFields = (row: Record<string, unknown>, fields: string) => Object.keys(row).sort().join() === fields;
const issueLink = (value: unknown): value is string => text(value, 240) &&
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(value);
function sourceLink(value: unknown): value is string {
  if (!text(value, 240)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch { return false; }
}

export function createSquadProjectService(input: {
  origin: string; squad: LiveSquadSpec; config: ForumAuthorityConfig; plane: SquadPlaneConfig;
  store: ReturnType<typeof createSquadProjectStore>;
  dispatch: ReturnType<typeof createSquadPlaneForum>;
  authenticate(request: Request): Promise<{ key: string } | null>;
  authenticateAgent?: (request: Request) => Promise<Agent | null>;
  read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot>;
  clock?: () => number;
}) {
  const site = new URL(input.origin), { forumId: forum, owner } = input.squad;
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const agentSession = input.authenticateAgent ?? (request => authenticateAgentRequest(request, ["forum:read"]));
  const reply = (status: number, body: object) => Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store", Vary: "Cookie, Origin, Authorization", "X-Content-Type-Options": "nosniff",
  } });

  async function authorize(request: Request, signal: AbortSignal, action: string): Promise<Actor> {
    const isNative = nativeRead(request, action);
    const agent = isNative ? await agentSession(request) : null;
    const session = isNative ? null : await input.authenticate(request);
    if (!agent && !session) return refuse(403, "authentication");
    const at = clock();
    const snapshot = await input.read(at, signal);
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 1024) return refuse(503, "authority");
    const authority = createForumAuthority(input.config, clock);
    const result = await authority.refresh(snapshot, at);
    signal.throwIfAborted();
    const graph = authority.graph;
    if (!result.ok || clock() !== at || roomAuthorityReadDiagnosticsBlock(result.diagnostics, snapshot) ||
        graph.ownerOf(forum) !== owner) return refuse(503, "authority");
    const principal = agent?.agent ?? (session && graph.principalForKey(session.key, at));
    if (!principal || isPublicSquadPrincipal(principal) || !graph.checkForumSee(forum, principal, at).allowed)
      return refuse(403, "access");
    if (agent && (agent.principal !== owner || !Object.values(input.plane.roster).includes(principal)))
      return refuse(403, "access");
    if (!isNative && Object.values(input.plane.roster).includes(principal)) return refuse(403, "access");
    if ((isNative || (action !== "board" && !artifactReadAction(action))) &&
        !graph.checkPost(forum, principal, at).allowed) return refuse(403, "access");
    if (action === "delegate" && principal !== owner) return refuse(403, "owner-required");
    return { principal, graph, at, agent: isNative };
  }

  function eligible(actor: Actor, principal: string) {
    return !isPublicSquadPrincipal(principal) && actor.graph.checkForumSee(forum, principal, actor.at).allowed &&
      actor.graph.checkPost(forum, principal, actor.at).allowed;
  }

  async function dispatch(request: Request, signal: AbortSignal, action: "tasks" | "control", body: object) {
    const result = await input.dispatch(new Request(request.url, {
      method: "POST", headers: request.headers, body: JSON.stringify(body), signal,
    }), action);
    if (!result.ok) {
      await result.body?.cancel();
      return refuse(result.status, "plane-assignment");
    }
    return await readBoundedIdentityJson(result, 4096, signal) as { taskId: string; status: string };
  }

  async function delegate(body: Record<string, unknown>, request: Request, signal: AbortSignal, actor: Actor,
    current: Awaited<ReturnType<typeof input.store.read>>) {
    const intent = parseSquadPlaneCommand("tasks", body.intent);
    const credential = request.headers.get("authorization");
    if (!sameFields(body, "action,cursor,forum,intent,taskId,taskRevision") || !intent || !natural(body.cursor) || !natural(body.taskRevision) ||
        !projectUuid(body.taskId) || !credential || !/^Bearer [A-Za-z0-9._~-]{1,8185}$/.test(credential))
      return refuse(400, "delegate-fields");
    const delegate = input.plane.roster[intent.bot_id];
    if (!delegate || delegate === actor.principal || !eligible(actor, delegate)) return refuse(403, "delegate-access");
    const { project } = current;
    const task = project.tasks.find(row => row.id === body.taskId);
    if (!task) return refuse(404, "task");
    const previous = latestProjectDelegation(project, task.id);
    const intentBody = { ...intent.scope, bot_id: intent.bot_id };
    const digest = projectDigest(intentBody);
    let registered: ProjectDelegation;
    let recovered = false;
    if (previous?.taskRevision === body.taskRevision && previous.intentDigest === digest && previous.status !== "rejected") {
      if (previous.status === "accepted") return reply(200, projectBoard(project));
      if (previous.leaseUntil > clock()) return refuse(409, "assignment-in-progress");
      const currentActor = await authorize(request, signal, "delegate");
      if (!eligible(currentActor, delegate)) return refuse(403, "delegate-access");
      recovered = true;
      previous.leaseUntil = clock() + 20;
      registered = previous;
      await input.store.save(project, current.etag, signal);
    } else {
      if (task.revision !== body.taskRevision || project.cursor !== body.cursor || previous?.status === "pending" ||
          project.ledger.some(item => item.sourceTaskId === intent.scope.source_task_id && item.status !== "rejected")) return refuse(409, "revision");
      if (previous?.status === "accepted") {
        const fact = await dispatch(request, signal, "control", {
          version: 1, bot_id: previous.botId, assignment_id: previous.assignmentId,
          session_id: previous.sessionId, source_task_id: previous.sourceTaskId,
        });
        if (!["completed", "cancelled", "failed"].includes(fact.status)) return refuse(409, "active-assignment");
      }
      const branch = projectBranch(project, task.nodeId);
      if (!branch || project.ledger.length >= 160) return refuse(409, "project-capacity");
      const nextActor = await authorize(request, signal, "delegate");
      if (!eligible(nextActor, delegate)) return refuse(403, "delegate-access");
      registered = {
        taskId: task.id, taskRevision: task.revision, cursor: ++project.cursor, requestedBy: actor.principal,
        delegate, botId: intent.bot_id, assignmentId: intent.scope.assignment_id, sessionId: intent.scope.session_id,
        sourceTaskId: intent.scope.source_task_id, intentDigest: digest, context: { task: { ...task }, branch },
        status: "pending", leaseUntil: clock() + 20,
      };
      task.revision++;
      project.ledger.push(registered);
      await input.store.save(project, current.etag, signal);
    }
    let fact: { taskId: string; status: string };
    try {
      fact = await dispatch(request, signal, "tasks", intentBody);
    } catch (error) {
      // A transport error is ambiguous. Leave the reservation fenced so an
      // exact retry can reconcile it after the short dispatch lease expires.
      if (recovered || !(error instanceof ProjectRefusal) || ![401, 403, 404, 409, 422].includes(error.status)) throw error;
      const denied = await input.store.read(signal);
      const held = latestProjectDelegation(denied.project, task.id);
      if (held?.status === "pending" && held.intentDigest === registered.intentDigest && held.leaseUntil === registered.leaseUntil) {
        await authorize(request, signal, "delegate");
        held.status = "rejected";
        held.cursor = ++denied.project.cursor;
        await input.store.save(denied.project, denied.etag, signal);
      }
      throw error;
    }
    const refreshed = await input.store.read(signal);
    const held = latestProjectDelegation(refreshed.project, task.id);
    if (!held || held.intentDigest !== registered.intentDigest || held.leaseUntil !== registered.leaseUntil)
      return refuse(409, "revision");
    const currentActor = await authorize(request, signal, "delegate");
    if (!eligible(currentActor, delegate)) return refuse(403, "delegate-access");
    held.status = "accepted";
    held.cursor = ++refreshed.project.cursor;
    held.planeTaskId = fact.taskId;
    await input.store.save(refreshed.project, refreshed.etag, signal);
    return reply(200, projectBoard(refreshed.project));
  }

  function resume(body: Record<string, unknown>, project: SquadProject, actor: Actor) {
    const byTask = sameFields(body, "action,forum,since,taskId") && projectUuid(body.taskId);
    const byDelivery = sameFields(body, "action,forum,planeTaskId,since") && projectUuid(body.planeTaskId);
    if ((!byTask && !byDelivery) || !natural(body.since)) return refuse(400, "resume-fields");
    const taskId = byTask ? body.taskId
      : project.ledger.findLast(row => row.planeTaskId === body.planeTaskId)?.taskId;
    const assignment = typeof taskId === "string" ? latestProjectDelegation(project, taskId) : undefined;
    if (byDelivery && assignment?.planeTaskId !== body.planeTaskId) return refuse(404, "task");
    if (!assignment || assignment.delegate !== actor.principal || assignment.status !== "accepted" ||
        input.plane.roster[assignment.botId] !== actor.principal) return refuse(404, "task");
    if (body.since > assignment.cursor) return refuse(409, "cursor");
    if (body.since === assignment.cursor) return reply(200, { taskId: assignment.taskId, cursor: assignment.cursor, changed: false });
    return reply(200, {
      taskId: assignment.taskId, cursor: assignment.cursor, changed: true, planeTaskId: assignment.planeTaskId,
      owner: assignment.context.task.owner, delegate: assignment.delegate, taskRevision: assignment.taskRevision,
      outcome: assignment.context.task.outcome, issue: assignment.context.task.issue, sources: assignment.context.task.sources,
      branch: assignment.context.branch, label: assignment.context.task.label,
    });
  }

  return async (request: Request): Promise<Response> => {
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12000)]);
      if (request.method !== "POST" || !matchesRequestOrigin(request, site) ||
          request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
        return reply(403, { error: "origin-or-type" });
      let body: unknown;
      try { body = await readBoundedIdentityJson(new Response(request.body), 95000, signal); }
      catch { return reply(400, { error: "request" }); }
      if (!record(body) || body.forum !== forum || typeof body.action !== "string") return reply(404, { error: "project" });
      const action = body.action;
      if (nativeRead(request, action) ? request.headers.has("origin") && !matchesBrowserOrigin(request, site) : !matchesBrowserOrigin(request, site))
        return reply(403, { error: "origin-or-type" });
      const actor = await authorize(request, signal, action);
      const current = await input.store.read(signal);
      const { project } = current;
      if (action === "board") {
        if (!sameFields(body, "action,forum")) return reply(400, { error: "fields" });
        const reader = await authorize(request, signal, action);
        if (reader.principal !== actor.principal) return refuse(403, "access");
        return reply(200, { ...projectBoard(project), canEdit: reader.graph.checkPost(forum, reader.principal, reader.at).allowed,
          canDelegate: reader.principal === owner, bots: reader.principal !== owner ? [] : Object.entries(input.plane.roster)
            .filter(([, principal]) => principal !== owner && eligible(reader, principal)).map(([id, principal]) => ({ id, principal })) });
      }
      if (action === "resume") {
        const refreshed = await authorize(request, signal, action);
        if (refreshed.principal !== actor.principal) return refuse(403, "access");
        return resume(body, project, refreshed);
      }
      if (isBriefAction(action) || isWorkbookAction(action) || previewReadAction(action)) {
        const checked = await authorize(request, signal, action);
        if (checked.principal !== actor.principal) return refuse(403, "access");
        const handle = isBriefAction(action) ? handleBriefAction : isWorkbookAction(action) ? handleWorkbookAction : handlePreviewAction;
        const result = handle(body, project, checked, owner);
        if (result.changed) {
          // Recheck after preparing the change and before the fenced write.
          const writer = await authorize(request, signal, action);
          if (writer.principal !== checked.principal) return refuse(403, "access");
          project.cursor++;
          await input.store.save(project, current.etag, signal);
        }
        const download: { name: string; bytes: BodyInit; contentType: string; headers?: Record<string, string> } | undefined = result.download;
        if (download) return new Response(download.bytes, { headers: {
          "Content-Type": download.contentType, "Cache-Control": "private, no-store",
          ...download.headers,
          "Content-Disposition": `attachment; filename="${download.name}"`,
          "X-Content-Type-Options": "nosniff",
        } });
        const task = project.tasks.find(row => row.id === body.taskId);
        const canReview = !checked.agent && checked.graph.checkPost(forum, checked.principal, checked.at).allowed;
        return reply(200, { ...result.view, canReview,
          canRevise: canReview && (checked.principal === owner || task?.owner === checked.principal) });
      }
      if (action === "delegate") return await delegate(body, request, signal, actor, current);
      if (action === "node") {
        if (!sameFields(body, "action,cursor,forum,id,parentId,title") || !projectUuid(body.id) ||
            (body.parentId !== null && !projectUuid(body.parentId)) || !text(body.title, 120) || !natural(body.cursor))
          return refuse(400, "node-fields");
        const existing = project.nodes.find(row => row.id === body.id);
        if (existing && existing.title === body.title && existing.parentId === body.parentId) return reply(200, projectBoard(project));
        if (project.cursor !== body.cursor || (!existing && project.nodes.length >= 64)) return refuse(409, "revision");
        if (body.parentId !== null && !projectBranch(project, body.parentId, body.id)) return refuse(409, "branch");
        const node = { id: body.id, parentId: body.parentId, title: body.title };
        if (existing) Object.assign(existing, node);
        else project.nodes.push(node);
        if (project.nodes.some(row => !projectBranch(project, row.id))) return refuse(409, "branch");
      } else if (action === "create-task") {
        if (!sameFields(body, "action,forum,id,issue,label,nodeId,outcome,sources") || !projectUuid(body.id) ||
            !projectUuid(body.nodeId) || !text(body.outcome, 240) || !isProjectLabel(body.label) ||
            !(body.issue === null || issueLink(body.issue)) || !Array.isArray(body.sources) ||
            body.sources.length > 4 || !body.sources.every(sourceLink)) return refuse(400, "task-fields");
        if (!project.nodes.some(row => row.id === body.nodeId)) return refuse(404, "node");
        const task: ProjectTask = { id: body.id, nodeId: body.nodeId, label: body.label, outcome: body.outcome,
          issue: body.issue, sources: body.sources, owner: actor.principal, revision: 0 };
        const existing = project.tasks.find(row => row.id === task.id);
        if (existing) {
          if (projectDigest({ ...existing, revision: 0 }) !== projectDigest(task)) return refuse(409, "task-conflict");
          return reply(200, projectBoard(project));
        }
        if (project.tasks.length >= 64) return refuse(409, "project-capacity");
        project.tasks.push(task);
      } else return refuse(404, "action");
      const checked = await authorize(request, signal, action);
      if (checked.principal !== actor.principal) return refuse(403, "access");
      project.cursor++;
      await input.store.save(project, current.etag, signal);
      return reply(200, projectBoard(project));
    } catch (error) {
      if (error instanceof ProjectRefusal || error instanceof ArtifactRefusal) return reply(error.status, { error: error.message });
      if (error instanceof RecordConflict) return reply(409, { error: "revision" });
      return reply(503, { error: "project-unavailable" });
    }
  };
}
