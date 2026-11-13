import type { openForumBotChannel, SignedBotStatement } from "./forum-bot-channel";
import type { openLocalBotApprovals, LocalBotApproval } from "./forum-bot-local-access";
import type { openForumBotArtifacts } from "./forum-bot-artifacts";
import type { BotMessage } from "./forum-bot-protocol";

export type BotExecutionStatus = Readonly<{ id: string; session: string; status: "queued" | "running" | "completed" | "failed" | "cancelled";
  completed_steps: number; total_steps: number; results: readonly unknown[] }>;
export type BotExecutor = Readonly<{
  consent(session: string): Promise<{ running: boolean; resume: number }>;
  submit(grant: LocalBotApproval, untilMs: number, resume: number): Promise<{ id: string }>;
  status(session: string, id: string): Promise<BotExecutionStatus>;
  cancel(session: string, id: string): Promise<void>;
}>;
/** One serial worker, one private inbox, one explicit bot identity. It never
 * resumes automation or reads task arguments from a forum statement.
 */
export function createForumBotWorker(input: {
  tenant: string; channel: ReturnType<typeof openForumBotChannel>; approvals: ReturnType<typeof openLocalBotApprovals>;
  artifacts: ReturnType<typeof openForumBotArtifacts>; executor: BotExecutor;
  refresh(): Promise<boolean>;
  /** Must durably enqueue and deduplicate by message contents before returning. */
  publish(message: BotMessage): Promise<void>;
  clock?: () => number;
}) {
  const { channel, approvals, artifacts, executor, refresh, publish } = input, clock = input.clock ?? Date.now;
  let active: { task: string; handle: string; session: string; local: string; until: number; progress: number; resume: number; grant: string; cancelRequested?: boolean; result?: BotMessage } | null = null;
  let stopped = false, uncertainUntil = 0, serial = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = serial.then(fn); serial = next.then(() => {}, () => {}); return next;
  };
  async function cancel() { if (active && !active.cancelRequested) { await executor.cancel(active.session, active.local); active.cancelRequested = true; } }
  return Object.freeze({
    deliver(chain: readonly SignedBotStatement[]) { return run(async () => {
      if (stopped || !await refresh()) throw Error("Forum authority unavailable");
      const before = channel.cursor(), after = chain.at(-1)?.id ?? "";
      return channel.receive(chain, before === after ? undefined : { before, after });
    }); },
    event(statement: SignedBotStatement) { return run(async () => {
      if (stopped || !await refresh()) throw Error("Forum authority unavailable");
      const result = await channel.event(statement);
      if (result.message[0] === "cancel" && active && result.affected.includes(active.task)) await cancel();
      return result;
    }); },
    tick() { return run(async () => {
      if (stopped) return;
      const fresh = await refresh().catch(() => false);
      if (active) {
        const current = active;
        const consent = await executor.consent(current.session).catch(() => ({ running: false, resume: -1 }));
        if (!consent.running || consent.resume !== current.resume || !fresh || clock() >= current.until || !channel.authorized(current.task) ||
            JSON.stringify(approvals.read(current.handle)) !== current.grant) await cancel();
        let status: BotExecutionStatus;
        try { status = await executor.status(current.session, current.local); }
        catch (error) { await cancel().catch(() => {}); throw error; }
        if (status.id !== current.local || status.session !== current.session) { await cancel(); throw Error("Local task binding changed"); }
        if (["completed", "failed", "cancelled"].includes(status.status)) {
          let artifact: string | null = null;
          // Preserve results locally only when the owner explicitly shares them.
          const grant = approvals.read(current.handle);
          if (!current.result) {
            if (fresh && status.status === "completed" && grant?.artifactReaders.length && JSON.stringify(grant) === current.grant) {
              try { artifact = artifacts.put(current.handle, current.task, "application/json", Buffer.from(JSON.stringify(status.results))); }
              catch { /* Execution can complete without an exportable artifact. */ }
            }
            current.result = ["result", input.tenant, current.task, status.status as "completed" | "failed" | "cancelled", artifact];
          }
          await publish(current.result);
          channel.finish(current.task, status.status as "completed" | "failed" | "cancelled"); active = null;
          return;
        }
        const percent = Math.floor(status.completed_steps * 100 / status.total_steps);
        if (fresh && Number.isInteger(percent) && percent >= 0 && percent <= 100 && percent !== current.progress) {
          await publish(["progress", input.tenant, current.task, percent]); current.progress = percent;
        }
        return;
      }
      if (!fresh || clock() < uncertainUntil) return;
      for (const id of channel.pending()) {
        const reference = channel.reference(id), grant = reference && approvals.read(reference.handle);
        if (!grant) continue;
        const consent = await executor.consent(grant.session);
        if (!consent.running || !await refresh() || !channel.authorized(id) ||
            JSON.stringify(approvals.read(grant.handle)) !== JSON.stringify(grant)) continue;
        // Claim commits before ANY request that can execute work. Uncertain
        // submission remains claimed/unknown, never automatically retried.
        const claimed = channel.claim(id); if (!claimed) continue;
        const until = Math.min(clock() + 14000, claimed.expires * 1000, grant.expires * 1000);
        if (until <= clock()) { channel.finish(id, "cancelled"); continue; }
        uncertainUntil = until;
        const submitted = await executor.submit(grant, until, consent.resume);
        if (!/^[0-9a-f-]{36}$/.test(submitted.id)) throw Error("Invalid local task identity");
        active = { task: id, handle: claimed.handle, session: grant.session, local: submitted.id, until, progress: -1, resume: consent.resume, grant: JSON.stringify(grant) };
        uncertainUntil = 0;
        await publish(["ack", input.tenant, id]); break;
      }
    }); },
    stop() { return run(async () => { stopped = true; await cancel(); }); },
  });
}
