import type { KeyObject } from "node:crypto";
import { createExperimentProvider } from "./experiment-provider";
import type { RecordStore } from "./record-store";

/** Server-owned cache reader. The cache transports bytes; only the pinned
 * Ed25519 key can authorize their contents. Never construct from request data. */
export async function createCachedExperimentProvider(input: {
  records: Pick<RecordStore, "get">; publicKey: KeyObject; domain: string; clock?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const provider = await createExperimentProvider(input);
  let pending: Promise<boolean> | undefined, nextRead = 0, lastRead = -1, closed = false;
  let controller: AbortController | undefined;
  function refresh(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (pending) return pending;
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) return Promise.resolve(false);
    if (now >= lastRead && now < nextRead) return Promise.resolve(false);
    lastRead = now; nextRead = now + 30;
    controller = new AbortController();
    const active = controller;
    // Abort the transport and bound the caller even if a broken injected store
    // ignores its signal. A late read cannot refresh the provider afterward.
    let timeout: ReturnType<typeof setTimeout>;
    const expired = new Promise<null>(resolve => { timeout = setTimeout(() => { active.abort(); resolve(null); }, 3000); });
    pending = (async () => {
      try {
        const stored = await Promise.race([Promise.resolve().then(() => input.records.get("cache", "experiments-v1-s3rch", active.signal)), expired]);
        if (closed || active.signal.aborted || !stored || stored.bytes.byteLength > 65536) return false;
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).sort().join() !== "payload,signature"
            || typeof value.payload !== "string" || typeof value.signature !== "string") return false;
        return await provider.refresh(value.payload, value.signature);
      } catch { return false; }
      finally { clearTimeout(timeout!); pending = undefined; if (controller === active) controller = undefined; }
    })();
    return pending;
  }
  return Object.freeze({
    refresh,
    definitions: provider.definitions,
    guardrailHealthy: provider.guardrailHealthy,
    choose: provider.choose,
    async close() { closed = true; controller?.abort(); await pending; await provider.close(); },
  });
}
