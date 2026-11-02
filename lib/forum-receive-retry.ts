import { recoveryObject, recoveryList } from "./identity/forum-recovery-records";

/** Bounded transport hints, never proofs. Live and removal channels have
 * distinct keys. Replays do not renew a slot's original expiry. */
export function createForumReceiveRetry(clock = Date.now) {
  let cursor = 0;
  const pending = new Map<string, { at: number; data: Record<string, unknown>; run: (data: unknown) => unknown }>();
  const prune = () => { for (const [key, row] of pending) if (clock() - row.at >= 30_000) pending.delete(key); };
  return {
    remember(key: string, data: unknown, run: (data: unknown) => unknown) {
      prune();
      if (key.length > 2048 || (!pending.has(key) && pending.size >= 256)) return false;
      const raw = recoveryObject(data); if (!raw || Object.keys(raw).length > 64) return false;
      const copy: Record<string, unknown> = Object.create(null);
      for (const [k, v] of Object.entries(raw)) {
        if (k === "_") continue;
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) copy[k] = v;
        else if (Array.isArray(v)) {
          const list = recoveryList(v);
          if (list && list.length <= 64 && list.every(s => typeof s === "string")) copy[k] = list;
        }
      }
      if (typeof copy.sig !== "string" || !copy.sig.startsWith("SEA") || JSON.stringify(copy).length > 32768) return false;
      pending.set(key, { at: pending.get(key)?.at ?? clock(), data: copy, run }); return true;
    },
    forget(key: string) { pending.delete(key); },
    retry() {
      prune();
      const rows = [...pending.values()];
      const start = rows.length ? cursor % rows.length : 0;
      cursor = (start + 32) % 256;
      for (let n = 0; n < rows.length; n++) {
        const row = rows[(start + n) % rows.length];
        try { void Promise.resolve(row.run(row.data)).catch(() => {}); } catch { /* Await the next bounded retry. */ }
      }
    },
    clear() { pending.clear(); },
    size() { prune(); return pending.size; },
  };
}
