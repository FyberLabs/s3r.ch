import { createHash } from "node:crypto";
import type { VerifiedForumUpdate } from "./forum-plane-update";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import { appendArtifactRevision, refuseArtifact, requireDeliveredArtifactTask, type ArtifactRevision } from "./squad-artifact";
import { latestProjectDelegation, projectUuid, type createSquadProjectStore, type SquadProject } from "./squad-project";
import { parsePricingInputs, pricingAnchor, pricingFormula, pricingSheet, pricingTotalCell, pricingTotalCents, type PricingInputs } from "./workbook-pricing";
import { exportPricingWorkbook, xlsxContentType } from "./workbook-xlsx";

export type WorkbookRevision = ArtifactRevision & { inputs: PricingInputs; formula: typeof pricingFormula };
type WorkbookComment = { id: string; revision: string; author: string; createdAt: number; sheet: string; range: string; text: string };
export type ProjectWorkbook = { id: string; taskId: string; format: "pricing-v1"; revisions: WorkbookRevision[]; comments: WorkbookComment[] };
export type SignedWorkbook = { artifactId: string; revisionId: string; taskId: string; inputs: PricingInputs; signature: string };

const exact = (value: unknown, fields: string): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === fields;
const digest = (inputs: PricingInputs) => createHash("sha256").update(JSON.stringify([
  "pricing-v1", pricingSheet, pricingTotalCell, pricingFormula, inputs.quantity, inputs.unitPriceCents, inputs.discountBps,
])).digest("hex");

export function parseSignedWorkbook(value: unknown): SignedWorkbook | null {
  if (!exact(value, "artifactId,inputs,revisionId,signature,taskId") || !projectUuid(value.artifactId) ||
      !projectUuid(value.revisionId) || !projectUuid(value.taskId) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) return null;
  const inputs = parsePricingInputs(value.inputs);
  return inputs ? { artifactId: value.artifactId, revisionId: value.revisionId, taskId: value.taskId, inputs, signature: value.signature } : null;
}
export function workbookDraftTranscript(update: VerifiedForumUpdate, draft: Omit<SignedWorkbook, "signature">) {
  return new TextEncoder().encode(JSON.stringify(["s3rch-squad-workbook-v1", update.tenant, update.forumId,
    update.principal, update.botId, update.assignmentId, update.sessionId, update.taskId, update.deliveryId,
    draft.taskId, draft.artifactId, draft.revisionId, digest(draft.inputs)]));
}
export function verifyWorkbookDraft(draft: SignedWorkbook, update: VerifiedForumUpdate, writerKey: string) {
  return update.status === "completed" && verifyForumKeySignature(writerKey, draft.signature, workbookDraftTranscript(update, draft));
}

export function createSquadWorkbookPublisher(store: ReturnType<typeof createSquadProjectStore>, clock: () => number) {
  return async (draft: SignedWorkbook, update: VerifiedForumUpdate, signal: AbortSignal, authorize: () => Promise<boolean>) => {
    const { project, etag } = await store.read(signal);
    const task = requireDeliveredArtifactTask(project, draft.taskId, update, "workbook");
    const workbooks = project.workbooks ??= [];
    let workbook = workbooks.find(row => row.taskId === draft.taskId);
    if (workbook) {
      if (workbook.id !== draft.artifactId || workbook.revisions[0]?.id !== draft.revisionId)
        return refuseArtifact(409, "workbook-initial-draft");
    } else {
      if (workbooks.length >= 32 || workbooks.some(row => row.id === draft.artifactId))
        return refuseArtifact(409, "workbook-capacity-or-id");
      workbook = { id: draft.artifactId, taskId: draft.taskId, format: "pricing-v1", revisions: [], comments: [] };
      workbooks.push(workbook);
    }
    const changed = appendArtifactRevision(workbook.revisions, {
      id: draft.revisionId, parent: null, author: update.principal, createdAt: clock(), sources: task.sources,
      run: { taskId: update.taskId, deliveryId: update.deliveryId }, inputs: draft.inputs, formula: pricingFormula,
      sha256: digest(draft.inputs),
    }, "workbook");
    if (!await authorize()) return refuseArtifact(403, "workbook-access");
    if (changed) {
      project.cursor++;
      await store.save(project, etag, signal);
    }
  };
}

function workbookView(workbook: ProjectWorkbook | undefined, id: string | null) {
  if (!workbook && id === null) return { workbook: null };
  const selected = workbook && (id ? workbook.revisions.find(row => row.id === id) : workbook.revisions.at(-1));
  if (!workbook || !selected) return refuseArtifact(404, "workbook-revision");
  return { workbook: { id: workbook.id, taskId: workbook.taskId, sheet: pricingSheet, totalCell: pricingTotalCell,
    current: workbook.revisions.at(-1)?.id, selected, totalCents: pricingTotalCents(selected.inputs),
    history: workbook.revisions.map(({ inputs: _inputs, formula: _formula, ...metadata }) => metadata),
    comments: workbook.comments.filter(row => row.revision === selected.id),
  } };
}
export type WorkbookView = NonNullable<ReturnType<typeof workbookView>["workbook"]>;

export const workbookReadAction = (action: unknown) => action === "workbook-read" || action === "workbook-export";
export const isWorkbookAction = (action: unknown) =>
  workbookReadAction(action) || action === "workbook-revise" || action === "workbook-comment";

export function handleWorkbookAction(body: Record<string, unknown>, project: SquadProject,
  actor: { principal: string; agent: boolean; at: number }, forumOwner: string) {
  if (!projectUuid(body.taskId)) return refuseArtifact(400, "workbook-task");
  const task = project.tasks.find(row => row.id === body.taskId);
  if (!task) return refuseArtifact(404, "workbook-task");
  if (actor.agent) {
    const run = latestProjectDelegation(project, task.id);
    if (run?.status !== "accepted" || run.delegate !== actor.principal) return refuseArtifact(404, "workbook-task");
  }
  const workbook = project.workbooks?.find(row => row.taskId === task.id);
  if (workbookReadAction(body.action)) {
    if (!exact(body, "action,forum,revisionId,taskId") || !(body.revisionId === null || projectUuid(body.revisionId)))
      return refuseArtifact(400, "workbook-revision");
    const view = workbookView(workbook, body.revisionId);
    if (body.action === "workbook-read") return { changed: false, view };
    if (!body.revisionId || !view.workbook) return refuseArtifact(404, "workbook-revision");
    const { id, selected } = view.workbook;
    return { changed: false, download: { name: `pricing-${id}-${selected.id}.xlsx`, contentType: xlsxContentType,
      bytes: new Uint8Array(exportPricingWorkbook(selected.inputs)) } };
  }

  if (actor.agent) return refuseArtifact(403, "workbook-editor");
  if (!workbook) return refuseArtifact(404, "workbook");
  if (body.action === "workbook-revise") {
    if (actor.principal !== task.owner && actor.principal !== forumOwner) return refuseArtifact(403, "workbook-editor");
    const inputs = parsePricingInputs(body.inputs);
    if (!exact(body, "action,base,forum,inputs,revisionId,taskId") || !projectUuid(body.base) ||
        !projectUuid(body.revisionId) || !inputs) return refuseArtifact(400, "workbook-inputs");
    const base = workbook.revisions.find(row => row.id === body.base);
    if (!base) return refuseArtifact(409, "workbook-base");
    const changed = appendArtifactRevision(workbook.revisions, {
      id: body.revisionId, parent: base.id, author: actor.principal, createdAt: actor.at, run: null, sources: base.sources,
      inputs, formula: pricingFormula, sha256: digest(inputs),
    }, "workbook");
    return { changed, view: workbookView(workbook, body.revisionId) };
  }

  const range = pricingAnchor(body.range);
  if (!exact(body, "action,forum,id,range,revisionId,sheet,taskId,text") || !projectUuid(body.id) ||
      !projectUuid(body.revisionId) || body.sheet !== pricingSheet || !range ||
      typeof body.text !== "string" || !body.text.trim() || body.text.length > 1000 || body.text.includes("\0"))
    return refuseArtifact(400, "workbook-comment");
  if (!workbook.revisions.some(row => row.id === body.revisionId)) return refuseArtifact(404, "workbook-revision");
  const comment: WorkbookComment = { id: body.id, revision: body.revisionId, author: actor.principal,
    createdAt: actor.at, sheet: pricingSheet, range, text: body.text };
  const prior = workbook.comments.find(row => row.id === comment.id);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify({ ...comment, createdAt: prior.createdAt }))
      return refuseArtifact(409, "workbook-retry");
    return { changed: false, view: workbookView(workbook, comment.revision) };
  }
  if (workbook.comments.length >= 80) return refuseArtifact(409, "workbook-capacity");
  workbook.comments.push(comment);
  return { changed: true, view: workbookView(workbook, comment.revision) };
}
