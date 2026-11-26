import { isAbsolute, join } from "node:path";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { privateBotDirectory, readPrivateBotFile } from "./forum-bot-local-access";
import { openSquadArtifactTools, SQUAD_ARTIFACT_TOOLS, squadFields, squadObject as object,
  validSquadOperationId as validId, type SquadArtifactTools } from "./squad-agent-artifacts";

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export function openSquadAgentClient(configPath: string, send: typeof fetch = fetch) {
  if (!isAbsolute(configPath)) throw Error("Private absolute config path required");
  const config: unknown = JSON.parse(readPrivateBotFile(configPath, 8192).toString("utf8"));
  if (!object(config) || !["bot,credentialFile,operationsDirectory,origin,tenant,version",
    "bot,credentialFile,operationsDirectory,origin,squadArtifacts,tenant,version"].includes(squadFields(config)) ||
      config.version !== 1 || !validId(config.bot) || !validId(config.tenant) ||
      typeof config.credentialFile !== "string" || !isAbsolute(config.credentialFile) ||
      typeof config.operationsDirectory !== "string" || typeof config.origin !== "string" ||
      !config.origin.startsWith("https://") || new URL(config.origin).origin !== config.origin) {
    throw Error("Invalid squad agent configuration");
  }
  const { bot, tenant, credentialFile, operationsDirectory, origin } = config;
  privateBotDirectory(operationsDirectory);
  const endpoint = new URL("/v1/remote-agent/prompt-submit", origin);
  let active = false;

  function admittedOperation(operationId: string) {
    if (!validId(operationId)) throw Error("Operation unavailable");
    privateBotDirectory(operationsDirectory);
    const raw = readPrivateBotFile(join(operationsDirectory, operationId + ".json"), 512 * 1024);
    const operation: unknown = JSON.parse(raw.toString("utf8"));
    if (!object(operation) || operation.version !== 1 || operation.operation_id !== operationId ||
        operation.tenant_id !== tenant || operation.bot_id !== bot ||
        !validId(operation.task_id) || !validId(operation.assignment_id) ||
        !validId(operation.device_id) || !validId(operation.enrollment_id) || !validId(operation.session_id))
      throw Error("Operation binding differs");
    return { raw, task: operation.task_id };
  }
  const artifacts = "squadArtifacts" in config
    ? openSquadArtifactTools(config.squadArtifacts, id => admittedOperation(id).task, send)
    : undefined;

  return Object.freeze({
    artifacts,
    async submit(operationId: string, externalSignal?: AbortSignal): Promise<string> {
      if (!validId(operationId) || active) throw Error("Operation unavailable");
      active = true;
      try {
        const { raw } = admittedOperation(operationId);
        const credential = readPrivateBotFile(credentialFile, 128).toString("utf8").trim();
        if (!/^hm_rag_[a-f0-9]{64}$/.test(credential)) throw Error("Enrolled remote credential required");
        const limit = AbortSignal.timeout(310000);
        const signal = externalSignal ? AbortSignal.any([externalSignal, limit]) : limit;
        const response = await send(endpoint, {
          method: "POST", redirect: "error", cache: "no-store", signal,
          headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
          body: new Uint8Array(raw),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error("Operation refused");
        }
        const value = await readBoundedIdentityJson(response, 2 * 1024 * 1024, signal);
        const first = object(value) && Array.isArray(value.choices) ? value.choices[0] : null;
        const message = object(first) && object(first.message) ? first.message.content : null;
        if (typeof message !== "string") throw Error("Operation output unavailable");
        return message;
      } finally {
        active = false;
      }
    },
  });
}

const tool = {
  name: "submit_admitted_operation",
  description: "Submit the private owner-admitted Conductor operation identified by its UUID.",
  inputSchema: {
    type: "object",
    properties: { operationId: { type: "string", pattern: uuidPattern } },
    required: ["operationId"],
    additionalProperties: false,
  },
};

type Submit = (id: string, signal?: AbortSignal) => Promise<string>;

function toolCall(params: unknown, submit: Submit, artifacts?: SquadArtifactTools) {
  if (!object(params) || !object(params.arguments) || !validId(params.arguments.operationId)) return null;
  const { operationId, checkpoint, artifact } = params.arguments;
  const fields = squadFields(params.arguments);
  if (params.name === tool.name && fields === "operationId") return (signal: AbortSignal) => submit(operationId, signal);
  if (artifacts && params.name === "resume_squad_project" && fields === "checkpoint,operationId")
    return (signal: AbortSignal) => artifacts.resume(operationId, checkpoint, signal);
  if (artifacts && params.name === "publish_squad_artifact" && fields === "artifact,operationId")
    return (signal: AbortSignal) => artifacts.publish(operationId, artifact, signal);
  return null;
}

export function createSquadAgentMcp(submit: Submit, artifacts?: SquadArtifactTools, stopped?: AbortSignal) {
  let initialized = false, ready = false;
  const pending = new Map<string | number, AbortController>();
  return async (line: string) => {
    let request: unknown;
    try { request = JSON.parse(line); }
    catch { return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    const { id, method, params } = request;
    if (id === undefined) {
      if (method === "notifications/initialized" && initialized) ready = true;
      if (method === "notifications/cancelled" && object(params)) {
        const { requestId } = params;
        if (typeof requestId === "string" || typeof requestId === "number") pending.get(requestId)?.abort();
      }
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    const response = (result: object) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize" && !initialized && object(params) && typeof params.protocolVersion === "string") {
      initialized = true;
      return response({ protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "s3rch-squad-agent", version: "1.0.0" } });
    }
    if (method === "ping") return response({});
    if (!ready) return error(-32002, "Server not initialized");
    if (method === "tools/list") return response({ tools: artifacts ? [tool, ...SQUAD_ARTIFACT_TOOLS] : [tool] });
    if (method !== "tools/call") return error(-32601, "Method unavailable");
    const invoke = toolCall(params, submit, artifacts);
    if (!invoke) return error(-32602, "Invalid tool arguments");
    if (pending.size) return error(-32000, "Agent is busy");
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      const text = await invoke(stopped ? AbortSignal.any([stopped, controller.signal]) : controller.signal);
      return response({ content: [{ type: "text", text }] });
    } catch {
      return response({ isError: true, content: [{ type: "text", text: "Operation unavailable. Check Plane for its status." }] });
    } finally {
      pending.delete(id);
    }
  };
}
