import { isAbsolute, join } from "node:path";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { privateBotDirectory, readPrivateBotFile } from "./forum-bot-local-access";
import { openSquadVisorTools, squadArtifactTools, type InvokeVisor, type SquadVisorTools } from "./squad-visor-client";

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = new RegExp(uuidPattern);
const validId = (id: unknown): id is string => typeof id === "string" &&
  uuid.test(id) && id !== "00000000-0000-0000-0000-000000000000";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function openSquadAgentClient(configPath: string, send: typeof fetch = fetch, invokeVisor?: InvokeVisor) {
  if (!isAbsolute(configPath)) throw Error("Private absolute config path required");
  const config: unknown = JSON.parse(readPrivateBotFile(configPath, 8192).toString("utf8"));
  if (!object(config) || !["bot,credentialFile,operationsDirectory,origin,tenant,version",
    "artifactTools,bot,credentialFile,operationsDirectory,origin,tenant,version"].includes(Object.keys(config).sort().join()) ||
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

  function readOperation(operationId: unknown) {
    if (!validId(operationId)) throw Error("Operation unavailable");
    privateBotDirectory(operationsDirectory);
    const raw = readPrivateBotFile(join(operationsDirectory, operationId + ".json"), 512 * 1024);
    const operation: unknown = JSON.parse(raw.toString("utf8"));
    if (!object(operation) || operation.version !== 1 || operation.operation_id !== operationId ||
        operation.tenant_id !== tenant || operation.bot_id !== bot ||
        !validId(operation.task_id) || !validId(operation.assignment_id) ||
        !validId(operation.device_id) || !validId(operation.enrollment_id) || !validId(operation.session_id)) {
      throw Error("Operation binding differs");
    }
    return { raw, taskId: operation.task_id };
  }
  const artifacts = "artifactTools" in config
    ? openSquadVisorTools(config.artifactTools, id => readOperation(id).taskId, invokeVisor) : undefined;

  return Object.freeze({
    artifacts,
    async submit(operationId: string, externalSignal?: AbortSignal): Promise<string> {
      if (!validId(operationId) || active) throw Error("Operation unavailable");
      active = true;
      try {
        const { raw } = readOperation(operationId);
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

const artifactToolList = [{
  name: squadArtifactTools.resume,
  description: "Resume the current Squad task and read exact revisions under the enrolled worker.",
  inputSchema: {
    type: "object", required: ["operationId", "taskId"], additionalProperties: false,
    properties: { operationId: { type: "string", pattern: uuidPattern }, taskId: { type: "string", pattern: uuidPattern },
      sources: { type: "object", additionalProperties: false, required: ["briefRevisionId", "workbookRevisionId"],
        properties: { briefRevisionId: { type: "string", pattern: uuidPattern }, workbookRevisionId: { type: "string", pattern: uuidPattern },
          previewRevisionId: { type: "string", pattern: uuidPattern } } } },
  },
}, {
  name: squadArtifactTools.publish,
  description: "Publish one unsigned, task-bound Squad draft after the current delivery completes.",
  inputSchema: {
    type: "object", required: ["operationId", "artifact"], additionalProperties: false,
    properties: { operationId: { type: "string", pattern: uuidPattern },
      artifact: { type: "object", additionalProperties: false, required: ["kind", "draft"],
        properties: { kind: { enum: ["brief", "workbook", "preview"] }, draft: { type: "object",
          required: ["taskId", "artifactId", "revisionId"], properties: {
            taskId: { type: "string", pattern: uuidPattern }, artifactId: { type: "string", pattern: uuidPattern },
            revisionId: { type: "string", pattern: uuidPattern } } } } } },
  },
}];

export function createSquadAgentMcp(
  submit: (id: string, signal?: AbortSignal) => Promise<string>, artifacts?: SquadVisorTools, stopped?: AbortSignal,
) {
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
    if (method === "tools/list") return response({ tools: artifacts ? [tool, ...artifactToolList] : [tool] });
    if (method !== "tools/call") return error(-32601, "Method unavailable");
    if (!object(params) || !object(params.arguments) || !validId(params.arguments.operationId)) return error(-32602, "Invalid tool arguments");
    const input = params.arguments, operationId = params.arguments.operationId;
    const operation = params.name === squadArtifactTools.resume ? artifacts?.resume
      : params.name === squadArtifactTools.publish ? artifacts?.publish : undefined;
    if (!operation && (params.name !== tool.name || Object.keys(input).join() !== "operationId"))
      return error(-32602, "Invalid tool arguments");
    if (pending.size) return error(-32000, "Agent is busy");
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      const signal = stopped ? AbortSignal.any([stopped, controller.signal]) : controller.signal;
      if (operation) {
        const value = await operation(input, signal);
        return response({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });
      }
      const text = await submit(operationId, signal);
      return response({ content: [{ type: "text", text }] });
    } catch {
      return response({ isError: true, content: [{ type: "text", text: "Operation unavailable. Check Plane for its status." }] });
    } finally {
      pending.delete(id);
    }
  };
}
