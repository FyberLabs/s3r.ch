import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { openSquadAgentIdentity } from "./squad-agent-identity";

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = new RegExp(uuidPattern);
export const validSquadOperationId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
export const squadObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

type RunVisor = (path: string, args: string[], input: string, signal: AbortSignal) => Promise<string>;

const runVisor: RunVisor = (path, args, input, signal) => new Promise((resolve, reject) => {
  const child = spawn(path, args, { signal, stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let size = 0;
  child.on("error", reject);
  child.stdin.on("error", reject).end(input);
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1_048_576) {
      child.kill();
      reject(Error("Visor output exceeds its limit"));
    } else {
      chunks.push(chunk);
    }
  });
  child.on("close", code => {
    if (code !== 0) {
      reject(Error("Visor refused the Squad operation"));
      return;
    }
    try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { reject(Error("Invalid Visor output")); }
  });
});

function resumeArgs(value: unknown) {
  if (!squadObject(value) || !validSquadOperationId(value.taskId)) throw Error("Squad task ID required");
  const base = ["0", value.taskId];
  const fields = Object.keys(value).sort().join();
  if (fields === "taskId") return base;
  if (!["briefRevisionId,taskId,workbookRevisionId", "briefRevisionId,previewBaseRevisionId,taskId,workbookRevisionId"].includes(fields) ||
      !validSquadOperationId(value.briefRevisionId) || !validSquadOperationId(value.workbookRevisionId))
    throw Error("Exact Squad artifact sources required");
  base.push("--sources", value.briefRevisionId, value.workbookRevisionId);
  if ("previewBaseRevisionId" in value) {
    if (!validSquadOperationId(value.previewBaseRevisionId)) throw Error("Invalid Squad preview base");
    base.push("--preview-base", value.previewBaseRevisionId);
  }
  return base;
}

export function openSquadArtifactTools(config: unknown, planeTask: (operation: string) => string,
  send: typeof fetch, execute = runVisor) {
  if (!squadObject(config) || Object.keys(config).sort().join() !== "forum,identityFile,visorBinary" ||
      typeof config.forum !== "string" || !/^forum_[A-Za-z0-9_-]{1,249}$/.test(config.forum) ||
      typeof config.identityFile !== "string" || !isAbsolute(config.identityFile) ||
      typeof config.visorBinary !== "string" || !isAbsolute(config.visorBinary))
    throw Error("Invalid managed Squad artifact configuration");
  const { forum, identityFile, visorBinary } = config;
  function deadline(parent?: AbortSignal) {
    const limit = AbortSignal.timeout(75_000);
    return parent ? AbortSignal.any([parent, limit]) : limit;
  }
  async function resume(task: string, refs: string[], signal: AbortSignal) {
    const identity = openSquadAgentIdentity(identityFile, send);
    const token = await identity.session(signal);
    signal.throwIfAborted();
    return execute(visorBinary, ["squad-resume", identity.origin, forum, task, identity.principal, ...refs], token + "\n", signal);
  }
  return Object.freeze({
    async resume(operation: string, input: unknown, parent?: AbortSignal) {
      return resume(planeTask(operation), resumeArgs(input), deadline(parent));
    },
    async publish(operation: string, artifact: unknown, parent?: AbortSignal) {
      if (!squadObject(artifact) || Object.keys(artifact).sort().join() !== "draft,kind" ||
          !["brief", "workbook", "preview"].includes(String(artifact.kind)) || !squadObject(artifact.draft) ||
          !validSquadOperationId(artifact.draft.taskId)) throw Error("Unsigned Squad artifact required");
      const raw = JSON.stringify(artifact);
      if (Buffer.byteLength(raw) > 65_536) throw Error("Squad artifact exceeds its limit");
      const task = planeTask(operation), signal = deadline(parent);
      await resume(task, ["0", artifact.draft.taskId], signal);
      signal.throwIfAborted();
      return execute(visorBinary, ["squad-publish", task], raw, signal);
    },
  });
}

export type SquadArtifactTools = ReturnType<typeof openSquadArtifactTools>;
export const SQUAD_ARTIFACT_TOOLS = [
  {
    name: "resume_squad_project",
    description: "Resume the Squad task bound to an admitted operation and read exact source revisions.",
    inputSchema: { type: "object", properties: {
      operationId: { type: "string", pattern: uuidPattern },
      checkpoint: { type: "object", properties: {
        taskId: { type: "string", pattern: uuidPattern },
        briefRevisionId: { type: "string", pattern: uuidPattern },
        workbookRevisionId: { type: "string", pattern: uuidPattern },
        previewBaseRevisionId: { type: "string", pattern: uuidPattern },
      }, required: ["taskId"], additionalProperties: false },
    }, required: ["operationId", "checkpoint"], additionalProperties: false },
  },
  {
    name: "publish_squad_artifact",
    description: "Submit one unsigned artifact draft via Visor after the bound operation completes.",
    inputSchema: { type: "object", properties: {
      operationId: { type: "string", pattern: uuidPattern },
      artifact: { type: "object", properties: {
        kind: { enum: ["brief", "workbook", "preview"] }, draft: { type: "object" },
      }, required: ["kind", "draft"], additionalProperties: false },
    }, required: ["operationId", "artifact"], additionalProperties: false },
  },
] as const;
