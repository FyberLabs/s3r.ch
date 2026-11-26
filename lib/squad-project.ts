import { createHash } from "node:crypto";
import type { RecordStore } from "./record-store";
import type { ProjectBrief } from "./squad-brief";
import type { ProjectWorkbook } from "./squad-workbook";
import type { ProjectPreview } from "./squad-preview";

export const squadProjectLabels = ["partner-pilot", "pricing"] as const;
export type ProjectLabel = typeof squadProjectLabels[number];
export type ProjectNode = { id: string; parentId: string | null; title: string };
export type ProjectTask = {
  id: string; nodeId: string; outcome: string; label: ProjectLabel; issue: string | null;
  sources: string[]; owner: string; revision: number;
};
export type ProjectDelegation = {
  taskId: string; taskRevision: number; cursor: number; requestedBy: string; delegate: string;
  botId: string; assignmentId: string; sessionId: string; sourceTaskId: string; intentDigest: string;
  context: { task: ProjectTask; branch: ProjectNode[] };
  status: "pending" | "accepted" | "rejected"; leaseUntil: number; planeTaskId?: string;
};
export type SquadProject = {
  version: 1; forum: string; tenant: string; cursor: number;
  nodes: ProjectNode[]; tasks: ProjectTask[]; ledger: ProjectDelegation[]; briefs?: ProjectBrief[]; workbooks?: ProjectWorkbook[]; previews?: ProjectPreview[];
};

export const projectUuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isProjectLabel = (value: unknown): value is ProjectLabel => value === "partner-pilot" || value === "pricing";
export function projectBranch(project: SquadProject, nodeId: string, moving?: string): ProjectNode[] | null {
  const nodes: ProjectNode[] = [];
  let next: string | null = nodeId;
  while (next !== null) {
    const node = project.nodes.find(row => row.id === next);
    if (!node || node.id === moving || nodes.length >= 8 || nodes.some(row => row.id === next)) return null;
    nodes.unshift(node);
    next = node.parentId;
  }
  return nodes;
}

export function projectBoard(project: SquadProject) {
  return { cursor: project.cursor, nodes: project.nodes, tasks: project.tasks,
    ledger: project.ledger.map(({ taskId, taskRevision, cursor, requestedBy, delegate, status, planeTaskId }) =>
      ({ taskId, taskRevision, cursor, requestedBy, delegate, status, planeTaskId })) };
}
export type ProjectBoard = ReturnType<typeof projectBoard>;
export const latestProjectDelegation = (project: SquadProject, taskId: string) =>
  project.ledger.findLast(row => row.taskId === taskId);
export const projectDigest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createSquadProjectStore(records: RecordStore, tenant: string, forum: string) {
  const name = "sqproj-" + projectDigest([tenant, forum]);
  const maxBytes = 384 * 1024;
  return {
    async read(signal: AbortSignal) {
      const row = await records.get("cache", name, signal);
      if (!row) return {
        etag: null, project: { version: 1, tenant, forum, cursor: 0, nodes: [], tasks: [], ledger: [] } as SquadProject,
      };
      if (row.bytes.byteLength > maxBytes) throw Error("Squad project capacity");
      const project = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.bytes)) as SquadProject;
      if (project?.version !== 1 || project.tenant !== tenant || project.forum !== forum ||
          !Number.isSafeInteger(project.cursor) || project.cursor < 0 ||
          !Array.isArray(project.nodes) || !Array.isArray(project.tasks) || !Array.isArray(project.ledger) ||
          (project.briefs !== undefined && !Array.isArray(project.briefs)) ||
          (project.workbooks !== undefined && !Array.isArray(project.workbooks)) ||
          (project.previews !== undefined && !Array.isArray(project.previews))) {
        throw Error("Invalid Squad project record");
      }
      return { project, etag: row.revision };
    },
    async remove(etag: string, signal: AbortSignal) {
      await records.delete("cache", name, etag, signal);
    },
    async save(project: SquadProject, etag: string | null, signal: AbortSignal) {
      const bytes = new TextEncoder().encode(JSON.stringify(project));
      if (bytes.byteLength > maxBytes) throw Error("Squad project capacity");
      await records.put("cache", name, bytes, etag, signal);
    },
  };
}
