import { isSeaPubkey } from "./identity/forum-check";
import type { DrawerRecord } from "./forum-drawer";
import type { AssignmentJournalState } from "./delegation-journal";
import type { AssignmentRunResult } from "./delegation-publish";
export type AssignmentScope = Readonly<{ forum: string; owner: string }>;
export type AssignmentView = Pick<AssignmentJournalState, "forum" | "owner" | "assignee" | "revision" | "operation" | "receipts">;
export type AssignmentClient = Readonly<{
  read(scope: AssignmentScope): Promise<AssignmentView>;
  start(scope: AssignmentScope, operationId: string, replacement: string, revision: number): Promise<AssignmentRunResult>;
  resume(scope: AssignmentScope, operationId: string, replacement: string): Promise<AssignmentRunResult>;
  publishChild(scope: AssignmentScope, record: DrawerRecord, signature: string): Promise<boolean>;
  abort(scope: AssignmentScope, operationId: string): Promise<void>;
}>;
/** Same-origin session-authenticated transport supplied by the provisioned Squad
 * source. No endpoint, token, fixture identity or live authority is defaulted. */
export function createHttpAssignmentClient(input: { base: string; fetch?: typeof fetch; headers?: () => HeadersInit }): AssignmentClient {
  const fetcher = input.fetch ?? fetch;
  async function request<T>(action: string, scope: AssignmentScope, fields: object = {}): Promise<T> {
    const response = await fetcher(`${input.base}/${action}`, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(input.headers?.()).entries()) },
      body: JSON.stringify({ ...scope, ...fields }) });
    if (!response.ok) throw Error(response.status === 403 ? "Assignment owner access is required." : "Assignment changed or evidence is unavailable. Reload and retry the saved operation.");
    return response.json() as Promise<T>;
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
    start: (scope, operationId, replacement, revision) => result("start", scope, operationId, replacement, { revision }),
    resume: (scope, operationId, replacement) => result("resume", scope, operationId, replacement),
    async publishChild(scope, record, signature) {
      try { return (await request<{ ok: boolean }>("child", scope, { record, signature })).ok === true; } catch { return false; }
    },
    async abort(scope, operationId) { await request("abort", scope, { operationId }); },
  });
}
