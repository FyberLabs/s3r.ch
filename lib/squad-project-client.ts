import type { ProjectBoard, ProjectTask } from "./squad-project";

export function squadProjectDelegationRequest(board: ProjectBoard, task: ProjectTask, intent: unknown) {
  const last = board.ledger.findLast(run => run.taskId === task.id);
  return { action: "delegate", taskId: task.id,
    taskRevision: last?.status === "pending" ? last.taskRevision : task.revision, cursor: board.cursor, intent };
}
