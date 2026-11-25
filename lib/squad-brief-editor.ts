import { applyBriefRevision, briefDigest, briefView, isBriefMarkdown, refuseBrief, type BriefAnnotation } from "./squad-brief";
import { latestProjectDelegation, projectUuid, type SquadProject } from "./squad-project";

export const briefReadAction = (action: unknown) => action === "brief-read" || action === "brief-export";
export const isBriefAction = (action: unknown) => briefReadAction(action) || action === "brief-revise" || action === "brief-review";
const exact = (body: Record<string, unknown>, fields: string) => Object.keys(body).sort().join() === fields;

export function handleBriefAction(body: Record<string, unknown>, project: SquadProject,
  actor: { principal: string; agent: boolean; at: number }, forumOwner: string) {
  if (!projectUuid(body.taskId)) return refuseBrief(400, "brief-task");
  const task = project.tasks.find(row => row.id === body.taskId);
  if (!task) return refuseBrief(404, "brief-task");
  if (actor.agent) {
    const assignment = latestProjectDelegation(project, task.id);
    if (assignment?.status !== "accepted" || assignment.delegate !== actor.principal) return refuseBrief(404, "brief-task");
  }
  const brief = project.briefs?.find(row => row.taskId === task.id);
  if (briefReadAction(body.action)) {
    if (!exact(body, "action,forum,revisionId,taskId") || !(body.revisionId === null || projectUuid(body.revisionId)))
      return refuseBrief(400, "brief-revision");
    const view = briefView(brief, body.revisionId);
    if (body.action === "brief-export") {
      if (!body.revisionId || !view.brief) return refuseBrief(404, "brief-revision");
      const { id, selected } = view.brief;
      return { changed: false, download: { name: `brief-${id}-${selected.id}.md`, bytes: selected.markdown, contentType: "text/markdown; charset=utf-8" } };
    }
    return { changed: false, view };
  }

  if (actor.agent) return refuseBrief(403, "brief-editor");
  if (!brief) return refuseBrief(404, "brief");
  if (body.action === "brief-revise") {
    if (actor.principal !== task.owner && actor.principal !== forumOwner) return refuseBrief(403, "brief-editor");
    if (!exact(body, "action,base,forum,markdown,revisionId,taskId") || !projectUuid(body.base) ||
        !projectUuid(body.revisionId) || !isBriefMarkdown(body.markdown)) return refuseBrief(400, "brief-fields");
    const base = brief.revisions.find(row => row.id === body.base);
    if (!base) return refuseBrief(409, "brief-base");
    const result = applyBriefRevision(project, { artifactId: brief.id, taskId: task.id,
      revision: { id: body.revisionId, parent: base.id, author: actor.principal, createdAt: actor.at,
        markdown: body.markdown, sha256: briefDigest(body.markdown), sources: base.sources, run: null },
    });
    return { changed: result.changed, view: briefView(brief, body.revisionId) };
  }

  if (!exact(body, "action,forum,id,kind,lines,revisionId,taskId,text") || !projectUuid(body.id) ||
      !projectUuid(body.revisionId) || (body.kind !== "comment" && body.kind !== "approve" && body.kind !== "request-changes") ||
      typeof body.text !== "string" || body.text.length > 1000 || (body.kind !== "approve" && !body.text.trim()) ||
      body.text.includes("\0")) return refuseBrief(400, "brief-review");
  const selected = brief.revisions.find(row => row.id === body.revisionId);
  if (!selected) return refuseBrief(404, "brief-revision");
  const total = selected.markdown.split("\n").length;
  let lines: [number, number] | null = null;
  if (body.lines !== null) {
    if (!Array.isArray(body.lines) || body.lines.length !== 2 || !body.lines.every(Number.isSafeInteger) ||
        body.lines[0] < 1 || body.lines[1] > total || body.lines[0] > body.lines[1]) return refuseBrief(400, "brief-lines");
    lines = [body.lines[0], body.lines[1]];
  }
  const prior = brief.annotations.find(note => note.id === body.id);
  const note: BriefAnnotation = { id: body.id, revision: selected.id, author: actor.principal, createdAt: actor.at,
    kind: body.kind, lines, text: body.text };
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify({ ...note, createdAt: prior.createdAt })) return refuseBrief(409, "brief-retry");
    return { changed: false, view: briefView(brief, selected.id) };
  }
  if (brief.annotations.length >= 80) return refuseBrief(409, "brief-capacity");
  brief.annotations.push(note);
  return { changed: true, view: briefView(brief, selected.id) };
}
