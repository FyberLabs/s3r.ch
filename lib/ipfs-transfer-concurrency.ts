/** Cooperative same-origin operation slots. No queue, lease clock or persisted credentials. */
export type TransferConcurrency = {
  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>;
};
const denied = () => new Error("Shared IPFS transfer slots unavailable");
export function createSharedTransferConcurrency(options: {
  current: () => boolean;
  locks?: Pick<LockManager, "request">;
}): TransferConcurrency {
  const current = options.current, locks = options.locks ?? globalThis.navigator?.locks;
  let pending = 0;
  function check(signal: AbortSignal) {
    if (signal.aborted || current() !== true || !locks) throw denied();
  }
  return Object.freeze({
    async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      check(signal);
      if (pending >= 2) throw denied();
      pending++;
      async function attempt(slot: number): Promise<T> {
        check(signal);
        return locks!.request(`s3rch-ipfs-transfer-slot-v1-${slot}`, {mode: "exclusive", ifAvailable: true}, async lock => {
          check(signal);
          if (!lock) {
            if (slot === 0) return attempt(1);
            throw denied();
          }
          // Keep the slot until work actually settles, even if it ignores cancellation.
          const result = await work();
          check(signal);
          return result;
        });
      }
      try { return await attempt(0); } finally { pending--; }
    },
  });
}
