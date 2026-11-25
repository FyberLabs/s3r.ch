import { createHash } from "node:crypto";
import type { VerifiedForumUpdate } from "./forum-plane-update";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import { previewCsp, renderPartnerPreview, type PreviewCopy } from "./partner-preview-html";
import { appendArtifactRevision, refuseArtifact, requireDeliveredArtifactTask, type ArtifactRevision } from "./squad-artifact";
import { latestProjectDelegation, projectUuid, type createSquadProjectStore, type SquadProject } from "./squad-project";
import { pricingSheet, pricingTotalCell, pricingTotalCents, type PricingInputs } from "./workbook-pricing";

type RevisionLink = { artifactId: string; revisionId: string; author: string };
type PreviewInputs = {
  brief: RevisionLink;
  workbook: RevisionLink & { sheet: string; cell: string; assumptions: PricingInputs; cents: number };
};
export type PreviewRevision = ArtifactRevision & {
  title: string; nextStep: string; html: string; inputs: PreviewInputs; submissionSha256: string;
};
export type ProjectPreview = { id: string; taskId: string; format: "partner-html-v1"; revisions: PreviewRevision[] };
type PreviewDraft = {
  artifactId: string; revisionId: string; taskId: string; base: string | null;
  briefRevisionId: string; workbookRevisionId: string; copy: PreviewCopy;
};
export type SignedPreview = PreviewDraft & { signature: string };

const exact = (value: unknown, fields: string): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join() === fields;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && value.trim() === value && !!value &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const digest = (value: readonly unknown[]) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseSignedPreview(value: unknown): SignedPreview | null {
  if (!exact(value, "artifactId,base,briefRevisionId,copy,revisionId,signature,taskId,workbookRevisionId") ||
      !projectUuid(value.artifactId) || !projectUuid(value.revisionId) || !projectUuid(value.taskId) ||
      !(value.base === null || projectUuid(value.base)) || !projectUuid(value.briefRevisionId) || !projectUuid(value.workbookRevisionId) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value.signature) ||
      !exact(value.copy, "highlights,nextStep,summary,title")) return null;
  const { title, summary, highlights, nextStep } = value.copy;
  if (!text(title, 120) || !text(summary, 1400) || !text(nextStep, 400) || !Array.isArray(highlights) ||
      highlights.length > 4 || !highlights.every(item => text(item, 240))) return null;
  return { artifactId: value.artifactId, revisionId: value.revisionId, taskId: value.taskId, base: value.base,
    briefRevisionId: value.briefRevisionId, workbookRevisionId: value.workbookRevisionId,
    copy: { title, summary, highlights, nextStep }, signature: value.signature };
}
export function previewDraftTranscript(update: VerifiedForumUpdate, draft: PreviewDraft) {
  const { title, summary, highlights, nextStep } = draft.copy;
  return new TextEncoder().encode(JSON.stringify(["s3rch-squad-preview-v1", update.tenant, update.forumId,
    update.principal, update.botId, update.assignmentId, update.sessionId, update.taskId, update.deliveryId,
    draft.taskId, draft.artifactId, draft.revisionId, draft.base, draft.briefRevisionId, draft.workbookRevisionId,
    digest([title, summary, highlights, nextStep])]));
}
export function verifyPreviewDraft(draft: SignedPreview, update: VerifiedForumUpdate, writerKey: string) {
  return update.status === "completed" && verifyForumKeySignature(writerKey, draft.signature, previewDraftTranscript(update, draft));
}

function previewArtifacts(project: SquadProject, taskId: string) {
  return {
    brief: project.briefs?.find(row => row.taskId === taskId),
    workbook: project.workbooks?.find(row => row.taskId === taskId),
  };
}

export function createSquadPreviewPublisher(store: ReturnType<typeof createSquadProjectStore>, clock: () => number) {
  return async (draft: SignedPreview, update: VerifiedForumUpdate, signal: AbortSignal, authorize: () => Promise<boolean>) => {
    const { project, etag } = await store.read(signal);
    requireDeliveredArtifactTask(project, draft.taskId, update, "preview");
    const { brief, workbook } = previewArtifacts(project, draft.taskId);
    const briefRevision = brief?.revisions.find(row => row.id === draft.briefRevisionId);
    const workbookRevision = workbook?.revisions.find(row => row.id === draft.workbookRevisionId);
    if (!brief || !briefRevision || !workbook || !workbookRevision)
      return refuseArtifact(404, "preview-input");
    const inputs: PreviewInputs = {
      brief: { artifactId: brief.id, revisionId: briefRevision.id, author: briefRevision.author },
      workbook: { artifactId: workbook.id, revisionId: workbookRevision.id, author: workbookRevision.author,
        sheet: pricingSheet, cell: pricingTotalCell, assumptions: workbookRevision.inputs, cents: pricingTotalCents(workbookRevision.inputs) },
    };
    const previews = project.previews ??= [];
    let preview = previews.find(row => row.taskId === draft.taskId);
    if (!preview) {
      if (previews.length >= 32 || previews.some(row => row.id === draft.artifactId))
        return refuseArtifact(409, "preview-capacity-or-id");
      preview = { id: draft.artifactId, taskId: draft.taskId, format: "partner-html-v1", revisions: [] };
      previews.push(preview);
    }
    if (preview.id !== draft.artifactId || preview.revisions.some(row => row.id !== draft.revisionId &&
        (row.run?.taskId === update.taskId || row.run?.deliveryId === update.deliveryId)))
      return refuseArtifact(409, "preview-delivery");
    const submissionSha256 = createHash("sha256").update(previewDraftTranscript(update, draft)).digest("hex");
    const prior = preview.revisions.find(row => row.id === draft.revisionId);
    if (prior) {
      if (prior.submissionSha256 !== submissionSha256) return refuseArtifact(409, "preview-retry");
      if (!await authorize()) return refuseArtifact(403, "preview-access");
      return;
    }
    const html = renderPartnerPreview(draft.copy, inputs.workbook.cents);
    const changed = appendArtifactRevision(preview.revisions, {
      id: draft.revisionId, parent: draft.base, author: update.principal, createdAt: clock(),
      sources: [...new Set([...briefRevision.sources, ...workbookRevision.sources])],
      run: { taskId: update.taskId, deliveryId: update.deliveryId }, sha256: digest([html, inputs]),
      title: draft.copy.title, nextStep: draft.copy.nextStep, html, inputs, submissionSha256,
    }, "preview");
    if (!await authorize()) return refuseArtifact(403, "preview-access");
    if (changed) {
      project.cursor++;
      await store.save(project, etag, signal);
    }
  };
}

export const previewReadAction = (action: unknown) => action === "preview-read" || action === "preview-export";

export function handlePreviewAction(body: Record<string, unknown>, project: SquadProject, actor: { principal: string; agent: boolean }) {
  if (!exact(body, "action,forum,revisionId,taskId") || !projectUuid(body.taskId) ||
      !(body.revisionId === null || projectUuid(body.revisionId))) return refuseArtifact(400, "preview-fields");
  const task = project.tasks.find(row => row.id === body.taskId);
  if (!task) return refuseArtifact(404, "preview-task");
  if (actor.agent) {
    const run = latestProjectDelegation(project, task.id);
    if (run?.status !== "accepted" || run.delegate !== actor.principal) return refuseArtifact(404, "preview-task");
  }
  const preview = project.previews?.find(row => row.taskId === task.id);
  if (!preview && body.revisionId === null && body.action === "preview-read")
    return { changed: false, view: { preview: null } };
  const selected = preview && (body.revisionId ? preview.revisions.find(row => row.id === body.revisionId) : preview.revisions.at(-1));
  if (!preview || !selected) return refuseArtifact(404, "preview-revision");
  if (body.action === "preview-export") {
    if (!body.revisionId) return refuseArtifact(400, "preview-revision");
    return { changed: false, download: { name: `preview-${preview.id}-${selected.id}.html`,
      contentType: "text/html; charset=utf-8", bytes: selected.html,
      headers: { "Content-Security-Policy": "sandbox; " + previewCsp, "Referrer-Policy": "no-referrer" },
    } };
  }
  const { brief, workbook } = previewArtifacts(project, task.id);
  return { changed: false, view: { preview: { id: preview.id, taskId: task.id, owner: task.owner, selected,
    current: preview.revisions.at(-1)?.id,
    history: preview.revisions.map(({ html: _html, ...metadata }) => metadata),
    newerBrief: brief?.revisions.at(-1)?.id !== selected.inputs.brief.revisionId,
    newerWorkbook: workbook?.revisions.at(-1)?.id !== selected.inputs.workbook.revisionId,
  } } };
}
export type PreviewView = NonNullable<NonNullable<ReturnType<typeof handlePreviewAction>["view"]>["preview"]>;
