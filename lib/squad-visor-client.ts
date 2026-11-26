import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { privateBotDirectory, readPrivateBotFile } from "./forum-bot-local-access";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";
import { projectUuid } from "./squad-project";

export const maxSquadToolBytes = 96 * 1024;
const maxDraftBytes = 65536;
const maxReplyBytes = 800 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const squadArtifactTools = {
  resume: "resume_squad_task",
  publish: "publish_squad_artifact",
} as const;

type VisorScope = {
  visorPath: string;
  runtimeDirectory: string;
  siteOrigin: string;
  forum: string;
  agent: string;
  sessionFile: string;
};

export type InvokeVisor = (
  scope: VisorScope, args: string[], stdin: Buffer, signal: AbortSignal,
) => Promise<unknown>;

function invokeVisor(scope: VisorScope, args: string[], stdin: Buffer, signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(scope.visorPath, args, {
      env: { HYPERMESH_RUNTIME_DIR: scope.runtimeDirectory },
      stdio: ["pipe", "pipe", "ignore"], signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const unavailable = () => reject(Error("Visor command unavailable"));
    child.once("error", unavailable);
    child.stdin.on("error", unavailable);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxReplyBytes) {
        child.kill("SIGKILL");
        unavailable();
        return;
      }
      chunks.push(chunk);
    });
    child.once("close", code => {
      if (code !== 0 || size > maxReplyBytes) return unavailable();
      try { resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); }
      catch { unavailable(); }
    });
    child.stdin.end(stdin);
  });
}

function parseScope(value: unknown): VisorScope {
  if (!record(value) || Object.keys(value).sort().join() !== "agent,forum,runtimeDirectory,sessionFile,siteOrigin,visorPath" ||
      typeof value.agent !== "string" || !isSeaPubkey(value.agent) ||
      typeof value.forum !== "string" || !isForumObjectId(value.forum, "forum") ||
      typeof value.siteOrigin !== "string" || !value.siteOrigin.startsWith("https://") ||
      new URL(value.siteOrigin).origin !== value.siteOrigin ||
      typeof value.visorPath !== "string" || !isAbsolute(value.visorPath) ||
      typeof value.runtimeDirectory !== "string" || !isAbsolute(value.runtimeDirectory) ||
      typeof value.sessionFile !== "string" || !isAbsolute(value.sessionFile)) throw Error("Invalid Visor artifact configuration");
  return { agent: value.agent, forum: value.forum, siteOrigin: value.siteOrigin, visorPath: value.visorPath,
    runtimeDirectory: value.runtimeDirectory, sessionFile: value.sessionFile };
}

function sources(value: unknown): string[] {
  if (value === undefined) return [];
  if (!record(value) || !["briefRevisionId,workbookRevisionId", "briefRevisionId,previewRevisionId,workbookRevisionId"]
      .includes(Object.keys(value).sort().join()) || !projectUuid(value.briefRevisionId) ||
      !projectUuid(value.workbookRevisionId)) throw Error("Invalid source revisions");
  const args = ["--sources", value.briefRevisionId, value.workbookRevisionId];
  if ("previewRevisionId" in value) {
    if (!projectUuid(value.previewRevisionId)) throw Error("Invalid preview revision");
    args.push("--preview-base", value.previewRevisionId);
  }
  return args;
}

export function openSquadVisorTools(
  config: unknown, planeTask: (operationId: unknown) => string, invoke: InvokeVisor = invokeVisor,
) {
  const scope = parseScope(config);
  privateBotDirectory(scope.runtimeDirectory);
  async function resume(delivery: string, task: string, refs: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    privateBotDirectory(scope.runtimeDirectory);
    const credential = readPrivateBotFile(scope.sessionFile, 8194);
    try {
      const reply = await invoke(scope, ["squad-resume", scope.siteOrigin, scope.forum, delivery, scope.agent,
        "0", task, ...refs], credential, signal);
      const context = record(reply) && refs.length ? reply.context : reply;
      if (!record(reply) || !record(context) || context.taskId !== task ||
          context.planeTaskId !== delivery || context.delegate !== scope.agent) throw Error("Squad resume binding differs");
      return reply;
    } finally {
      credential.fill(0);
    }
  }
  const deadline = (signal?: AbortSignal) => signal
    ? AbortSignal.any([signal, AbortSignal.timeout(85000)]) : AbortSignal.timeout(85000);
  return Object.freeze({
    async resume(input: unknown, signal?: AbortSignal) {
      if (!record(input) || !projectUuid(input.taskId) ||
          !["operationId,taskId", "operationId,sources,taskId"].includes(Object.keys(input).sort().join()))
        throw Error("Invalid Squad resume arguments");
      return resume(planeTask(input.operationId), input.taskId, sources(input.sources), deadline(signal));
    },
    async publish(input: unknown, signal?: AbortSignal) {
      if (!record(input) || Object.keys(input).sort().join() !== "artifact,operationId" ||
          !record(input.artifact) || Object.keys(input.artifact).sort().join() !== "draft,kind" ||
          typeof input.artifact.kind !== "string" || !["brief", "workbook", "preview"].includes(input.artifact.kind))
        throw Error("Invalid Squad artifact arguments");
      const draft = input.artifact.draft;
      if (!record(draft) || "signature" in draft || !projectUuid(draft.taskId) ||
          !projectUuid(draft.artifactId) || !projectUuid(draft.revisionId)) throw Error("Invalid unsigned Squad draft");
      const bytes = Buffer.from(JSON.stringify(input.artifact));
      if (bytes.length > maxDraftBytes) throw Error("Squad draft too large");
      const delivery = planeTask(input.operationId);
      const bounded = deadline(signal);
      await resume(delivery, draft.taskId, [], bounded);
      bounded.throwIfAborted();
      const reply = await invoke(scope, ["squad-publish", delivery], bytes, bounded);
      if (!record(reply) || Object.keys(reply).sort().join() !== "artifactId,revisionId,taskId,version" ||
          reply.version !== 1 || reply.taskId !== draft.taskId || reply.artifactId !== draft.artifactId ||
          reply.revisionId !== draft.revisionId) throw Error("Squad artifact acknowledgement differs");
      return reply;
    },
  });
}

export type SquadVisorTools = ReturnType<typeof openSquadVisorTools>;
