import { createHash } from "node:crypto";
import type { VerifiedForumUpdate } from "./forum-plane-update";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import { latestProjectDelegation, projectUuid, type createSquadProjectStore, type SquadProject } from "./squad-project";

export type BriefRevision = {
  id: string; parent: string | null; author: string; createdAt: number; markdown: string;
  sha256: string; sources: string[]; run: { taskId: string; deliveryId: string } | null;
};
export type BriefAnnotation = {
  id: string; revision: string; author: string; createdAt: number; text: string;
  kind: "comment" | "approve" | "request-changes"; lines: [number, number] | null;
};
export type ProjectBrief = {
  id: string; taskId: string; format: "markdown"; revisions: BriefRevision[]; annotations: BriefAnnotation[];
};
export type SignedBriefDraft = {
  artifactId: string; revisionId: string; taskId: string; base: string | null; markdown: string; signature: string;
};

export class BriefRefusal extends Error {
  constructor(readonly status: number, reason: string) { super(reason); }
}
export const refuseBrief = (status: number, reason: string): never => { throw new BriefRefusal(status, reason); };
export const briefDigest = (markdown: string) => createHash("sha256").update(markdown, "utf8").digest("hex");
export const isBriefMarkdown = (value: unknown): value is string => typeof value === "string" && !!value.trim() &&
  !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 12 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseSignedBriefDraft(value: unknown): SignedBriefDraft | null {
  if (!record(value) || Object.keys(value).sort().join() !== "artifactId,base,markdown,revisionId,signature,taskId" ||
      !projectUuid(value.artifactId) || !projectUuid(value.revisionId) || !projectUuid(value.taskId) ||
      !(value.base === null || projectUuid(value.base)) || !isBriefMarkdown(value.markdown) ||
      typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) return null;
  return { artifactId: value.artifactId, revisionId: value.revisionId, taskId: value.taskId,
    base: value.base, markdown: value.markdown, signature: value.signature };
}

export function briefDraftTranscript(update: VerifiedForumUpdate, draft: Omit<SignedBriefDraft, "signature">) {
  return new TextEncoder().encode(JSON.stringify(["s3rch-squad-brief-v1", update.tenant, update.forumId,
    update.principal, update.botId, update.assignmentId, update.sessionId, update.taskId, update.deliveryId,
    draft.taskId, draft.artifactId, draft.revisionId, draft.base, briefDigest(draft.markdown)]));
}
export function verifyBriefDraft(draft: SignedBriefDraft, update: VerifiedForumUpdate, writerKey: string) {
  return update.status === "completed" && verifyForumKeySignature(writerKey, draft.signature, briefDraftTranscript(update, draft));
}

export function applyBriefRevision(project: SquadProject, input: {
  artifactId: string; taskId: string; revision: BriefRevision;
}) {
  const briefs = project.briefs ??= [];
  let brief = briefs.find(row => row.taskId === input.taskId);
  const { revision } = input;
  if (!brief) {
    if (revision.parent !== null || briefs.some(row => row.id === input.artifactId)) return refuseBrief(409, "brief-base");
    if (briefs.length >= 32) return refuseBrief(409, "brief-capacity");
    brief = { id: input.artifactId, taskId: input.taskId, format: "markdown", revisions: [], annotations: [] };
    briefs.push(brief);
  }
  if (brief.id !== input.artifactId) return refuseBrief(409, "brief-id");
  const prior = brief.revisions.find(row => row.id === revision.id);
  if (prior) {
    if (prior.parent !== revision.parent || prior.author !== revision.author || prior.sha256 !== revision.sha256 ||
        JSON.stringify(prior.run) !== JSON.stringify(revision.run)) return refuseBrief(409, "brief-retry");
    return { changed: false, brief };
  }
  if ((brief.revisions.at(-1)?.id ?? null) !== revision.parent) return refuseBrief(409, "brief-base");
  if (brief.revisions.length >= 24) return refuseBrief(409, "brief-capacity");
  brief.revisions.push(revision);
  return { changed: true, brief };
}

export function applyDeliveredBrief(project: SquadProject, draft: SignedBriefDraft, update: VerifiedForumUpdate, createdAt: number) {
  const run = latestProjectDelegation(project, draft.taskId);
  if (!run || run.status !== "accepted" || run.delegate !== update.principal || run.botId !== update.botId ||
      run.assignmentId !== update.assignmentId || run.sessionId !== update.sessionId || run.planeTaskId !== update.taskId ||
      project.forum !== update.forumId || project.tenant !== update.tenant) return refuseBrief(403, "brief-run");
  return applyBriefRevision(project, {
    artifactId: draft.artifactId, taskId: draft.taskId,
    revision: { id: draft.revisionId, parent: draft.base, author: update.principal, createdAt, markdown: draft.markdown,
      sha256: briefDigest(draft.markdown), sources: run.context.task.sources,
      run: { taskId: update.taskId, deliveryId: update.deliveryId } },
  });
}

export function briefView(brief: ProjectBrief | undefined, revisionId: string | null) {
  if (!brief) {
    if (revisionId) return refuseBrief(404, "brief-revision");
    return { brief: null };
  }
  const selected = revisionId ? brief.revisions.find(row => row.id === revisionId) : brief.revisions.at(-1);
  if (!selected) return refuseBrief(404, "brief-revision");
  return {
    brief: { id: brief.id, format: brief.format, taskId: brief.taskId, selected, current: brief.revisions.at(-1)?.id,
      history: brief.revisions.map(({ markdown: _markdown, ...metadata }) => metadata),
      annotations: brief.annotations.filter(note => note.revision === selected.id) },
  };
}
export type BriefView = NonNullable<ReturnType<typeof briefView>["brief"]>;

export function createSquadBriefPublisher(store: ReturnType<typeof createSquadProjectStore>, clock: () => number) {
  return async (draft: SignedBriefDraft, update: VerifiedForumUpdate, signal: AbortSignal, authorize: () => Promise<boolean>) => {
    const { project, etag } = await store.read(signal);
    const result = applyDeliveredBrief(project, draft, update, clock());
    if (!await authorize()) return refuseBrief(403, "brief-access");
    if (result.changed) {
      project.cursor++;
      await store.save(project, etag, signal);
    }
  };
}
