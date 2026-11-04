import { createDelegationRuntime } from "./delegation-runtime";
import type { createSquadCommitStore } from "./squad-commit-store";

/** Create a fresh runtime per authenticated request. History and journal share
 * a pinned CAS view; a conflict/lost acknowledgement requires a new request and
 * reopening durable operation state, never a retry on stale verified history. */
export async function createSquadRuntimeRequest(source: ReturnType<typeof createSquadCommitStore>,
  options: Omit<Parameters<typeof createDelegationRuntime>[0], "journal" | "history">) {
  const view = await source.open();
  return createDelegationRuntime({ ...options, ...view });
}
