/** Process-local publication quiescence only. Closing is permanent for this
 * instance. Drain waits for accepted signing/put calls to settle; it does not
 * acknowledge durable Gun writes, revoke ACLs or stop an external worker.
 */
export function createForumPublicationFence() {
  let closed = false, pending = 0;
  const waiters = new Set<() => void>();
  return Object.freeze({
    enter() {
      if (closed) return null;
      pending++;
      let finished = false;
      return Object.freeze({
        allowed: () => !closed && !finished,
        finish() {
          if (finished) return;
          finished = true; pending--;
          if (!pending) { for (const resolve of waiters) resolve(); waiters.clear(); }
        },
      });
    },
    close(): Promise<void> {
      closed = true; // Fence new work synchronously, before returning a promise.
      return pending === 0 ? Promise.resolve() : new Promise(resolve => { waiters.add(resolve); });
    },
  });
}
