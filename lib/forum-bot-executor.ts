import type { BotExecutor, BotExecutionStatus } from "./forum-bot-worker";
import { readPrivateBotFile } from "./forum-bot-local-access";
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
/** Explicit opt-in Visor loopback API. No cloud credential, session creation,
 * automation start/resume, arbitrary URL, or shell command is accepted here.
 */
export function createLocalBotExecutor(input: { origin: string; tokenFile: string; fetch?: typeof fetch }): BotExecutor {
  const url = new URL(input.origin);
  if (url.origin !== input.origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw Error("Explicit Visor IPv4 loopback origin required");
  const origin = input.origin, file = input.tokenFile, fetcher = input.fetch ?? fetch;
  async function request(method: string, path: string, body?: unknown) {
    const token = readPrivateBotFile(file, 1024).toString("utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw Error("Invalid local Visor credential");
    const response = await fetcher(origin + path, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(2000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok || response.redirected || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
      await response.body?.cancel(); throw Error("Local Visor request refused");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 1048576) { await reader.cancel(); throw Error("Local Visor response too large"); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const path = (session: string, id?: string) => {
    if (!uuid(session) || (id !== undefined && !uuid(id))) throw Error("Invalid local task scope");
    return `/session/${session}/tasks${id === undefined ? "" : "/" + id}`;
  };
  const status = (value: any, session: string, id: string): BotExecutionStatus => {
    if (!value || value.id !== id || value.session !== session || !["queued", "running", "completed", "failed", "cancelled"].includes(value.status) ||
        !Number.isInteger(value.total_steps) || value.total_steps < 1 || value.total_steps > 16 ||
        !Number.isInteger(value.completed_steps) || value.completed_steps < 0 || value.completed_steps > value.total_steps ||
        !Array.isArray(value.results) || value.results.length > 16) throw Error("Local Visor task binding differs");
    return value;
  };
  return Object.freeze({
    async consent(session) {
      if (!uuid(session)) throw Error("Invalid local session");
      const value = await request("GET", "/companion"), resume = value?.automation?.resume_seq;
      return { running: value?.session?.id === session && value?.automation?.phase === "running" && Number.isSafeInteger(resume) && resume >= 0,
        resume: Number.isSafeInteger(resume) && resume >= 0 ? resume : 0 };
    },
    async submit(grant, untilMs, resume) {
      const value = await request("POST", path(grant.session) + "/leased", { task: grant.task, authorized_until_ms: untilMs, resume_seq: resume });
      if (!uuid(value?.id)) throw Error("Invalid local task identity"); status(value, grant.session, value.id); return { id: value.id };
    },
    async status(session, id) { return status(await request("GET", path(session, id)), session, id); },
    async cancel(session, id) {
      const value = await request("DELETE", path(session, id)); status(value, session, id);
      if (value.cancel_requested !== true && !["completed", "failed", "cancelled"].includes(value.status)) throw Error("Local cancellation unconfirmed");
    },
  });
}
