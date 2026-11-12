import { isSeaPubkey } from "./identity/forum-check";
import { parseDrawerRecord, type DrawerRecord } from "./forum-drawer";
import type { AssignmentJournalState } from "./delegation-journal";
import type { AssignmentRunResult } from "./delegation-publish";
export type AssignmentScope = Readonly<{ forum: string; owner: string }>;
export type AssignmentView = Pick<AssignmentJournalState, "forum" | "owner" | "assignee" | "revision" | "operation" | "receipts">;
export type AssignmentClient = Readonly<{
  read(scope: AssignmentScope): Promise<AssignmentView>;
  start(scope: AssignmentScope, operationId: string, replacement: string, revision: number): Promise<AssignmentRunResult>;
  resume(scope: AssignmentScope, operationId: string, replacement: string): Promise<AssignmentRunResult>;
  readChild(scope: AssignmentScope, id: string): Promise<{ record: DrawerRecord; signature: string } | null>;
  publishChild(scope: AssignmentScope, record: DrawerRecord, signature: string): Promise<boolean>;
  abort(scope: AssignmentScope, operationId: string): Promise<void>;
}>;
/** Same-origin session-authenticated transport supplied by the provisioned Squad
 * source. No endpoint, token, fixture identity or live authority is defaulted. */
export function createHttpAssignmentClient(input: { base: string; fetch?: typeof fetch; headers?: () => HeadersInit;
  signPlan?: (plan: unknown, requested: AssignmentScope & { operationId: string; replacement: string; revision: number }) => Promise<unknown>;
}): AssignmentClient {
  const fetcher = input.fetch ?? fetch;
  async function request<T>(action: string, scope: AssignmentScope, fields: object = {}): Promise<T> {
    const response = await fetcher(`${input.base}/${action}`, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(input.headers?.()).entries()) },
      body: JSON.stringify({ ...scope, ...fields }) });
    if (!response.ok) throw Error(response.status === 403 ? "Assignment owner access is required." : "Assignment changed or evidence is unavailable. Reload and retry the saved operation.");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 524288)) { await response.body?.cancel(); throw Error("Assignment response too large"); }
    if (!response.body) throw Error("Missing assignment response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 524288) { await reader.cancel(); throw Error("Assignment response too large"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  }
  const operationIdOK = (id: unknown) => typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
  const receiptOK = (r: AssignmentView["receipts"][string] | undefined) => !!r && operationIdOK(r.operationId) &&
    isSeaPubkey(r.replacement) && typeof r.revision === "string" && /^[1-9][0-9]*$/.test(r.revision) &&
    Number.isSafeInteger(Number(r.revision)) && Number.isSafeInteger(r.evaluatedAt) && r.evaluatedAt >= 0;
  async function result(action: string, scope: AssignmentScope, operationId: string, replacement: string, fields: object = {}) {
    const r = await request<AssignmentRunResult>(action, scope, { ...fields, operationId, replacement });
    if (!r || (r.status !== "complete" && r.status !== "pending") ||
        (r.status === "complete" && (!receiptOK(r.receipt) || r.receipt.operationId !== operationId || r.receipt.replacement !== replacement)) ||
        (r.status === "pending" && (r.operationId !== operationId || !["cancellations", "replacement", "commit"].includes(r.stage))))
      throw Error("Invalid assignment evidence. Reload to recover the saved operation.");
    return r;
  }
  return Object.freeze({
    async read(scope) {
      const view = await request<AssignmentView>("read", scope);
      if (!view || view.forum !== scope.forum || view.owner !== scope.owner || !isSeaPubkey(view.assignee) ||
          !Number.isSafeInteger(view.revision) || view.revision < 0 ||
          !(view.operation === null || (view.operation && operationIdOK(view.operation.id) && isSeaPubkey(view.operation.replacement) &&
            isSeaPubkey(view.operation.previous) && ["cancellations", "replacement", "complete", "aborted"].includes(view.operation.phase))) ||
          !view.receipts || typeof view.receipts !== "object" || Array.isArray(view.receipts) || Object.keys(view.receipts).length > 256 ||
          Object.entries(view.receipts).some(([id, r]) => !receiptOK(r) || r.operationId !== id || Number(r.revision) > view.revision))
        throw Error("Invalid assignment scope or evidence.");
      return view;
    },
    async start(scope, operationId, replacement, revision) {
      if (!input.signPlan) return result("start", scope, operationId, replacement, { revision });
      const requested = { ...scope, operationId, replacement, revision };
      const plan = await request<unknown>("plan", scope, { operationId, replacement, revision });
      const material = await input.signPlan(plan, requested);
      return result("start-signed", scope, operationId, replacement, { revision, material });
    },
    resume: (scope, operationId, replacement) => result("resume", scope, operationId, replacement),
    async readChild(scope, id) {
      const value = await request<{ record: DrawerRecord; signature: string } | null>("read-child", scope, { id });
      if (value === null) return null;
      const record = parseDrawerRecord(value?.record);
      if (!record || record.id !== id || record.forumId !== scope.forum || record.agent !== scope.owner ||
          typeof value.signature !== "string" || !value.signature.startsWith("SEA") || value.signature.length > 32768)
        throw Error("Invalid saved child evidence.");
      return { record, signature: value.signature };
    },
    async publishChild(scope, record, signature) {
      try { return (await request<{ ok: boolean }>("child", scope, { record, signature })).ok === true; } catch { return false; }
    },
    async abort(scope, operationId) { await request("abort", scope, { operationId }); },
  });
}
