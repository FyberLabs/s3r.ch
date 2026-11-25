import type { VerifiedForumUpdate } from "./forum-plane-update";
import { latestProjectDelegation, type SquadProject } from "./squad-project";

export class ArtifactRefusal extends Error {
  constructor(readonly status: number, reason: string) { super(reason); }
}
export const refuseArtifact = (status: number, reason: string): never => { throw new ArtifactRefusal(status, reason); };

export type ArtifactRevision = {
  id: string; parent: string | null; author: string; createdAt: number;
  sha256: string; sources: string[]; run: { taskId: string; deliveryId: string } | null;
};

export function appendArtifactRevision<T extends ArtifactRevision>(revisions: T[], revision: T, kind: string) {
  const prior = revisions.find(row => row.id === revision.id);
  if (prior) {
    if (prior.parent !== revision.parent || prior.author !== revision.author || prior.sha256 !== revision.sha256 ||
        prior.run?.deliveryId !== revision.run?.deliveryId || prior.run?.taskId !== revision.run?.taskId)
      return refuseArtifact(409, kind + "-retry");
    return false;
  }
  if ((revisions.at(-1)?.id ?? null) !== revision.parent) return refuseArtifact(409, kind + "-base");
  if (revisions.length >= 24) return refuseArtifact(409, kind + "-capacity");
  revisions.push(revision);
  return true;
}

export function requireDeliveredArtifactTask(project: SquadProject, taskId: string, update: VerifiedForumUpdate, kind: string) {
  const run = latestProjectDelegation(project, taskId);
  if (update.status !== "completed" || !run || run.status !== "accepted" || run.delegate !== update.principal ||
      run.botId !== update.botId || run.assignmentId !== update.assignmentId || run.sessionId !== update.sessionId ||
      run.planeTaskId !== update.taskId || project.forum !== update.forumId || project.tenant !== update.tenant)
    return refuseArtifact(403, kind + "-run");
  return run.context.task;
}
