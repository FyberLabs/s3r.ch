import type { InventoryStore } from "../delegation-inventory";

/** Dedicated durable CAS slot; never reuse an assignment/inventory slot. Used
 * IDs survive process restart and concurrent service instances. Capacity denies
 * new exchanges rather than evicting still-live challenges. */
export function createSquadSessionReplayStore(store: InventoryStore, clock = () => Math.floor(Date.now() / 1000)) {
  return async (id: string, expiresAt: number): Promise<boolean> => {
    if (!/^[0-9a-f]{64}$/.test(id) || !Number.isSafeInteger(expiresAt)) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0 || expiresAt <= now || expiresAt > now + 60) return false;
      const held = await store.read();
      if (held && (!held.etag || held.etag === "*" || held.text.length > 400_000)) return false;
      let rows: [string, number][] = [];
      if (held) {
        try {
          const parsed = JSON.parse(held.text);
          if (!parsed || Object.keys(parsed).sort().join() !== "used,version" || parsed.version !== 1 || !Array.isArray(parsed.used) || parsed.used.length > 4096) return false;
          rows = parsed.used;
          if (rows.some(r => !Array.isArray(r) || r.length !== 2 || typeof r[0] !== "string" || !/^[0-9a-f]{64}$/.test(r[0]) || !Number.isSafeInteger(r[1]) || r[1] < 0) || new Set(rows.map(r => r[0])).size !== rows.length) return false;
        } catch { return false; }
      }
      if (rows.some(([key]) => key === id)) return false;
      rows = rows.filter(([, until]) => until > now);
      if (rows.length >= 4096) return false;
      rows.push([id, expiresAt]);
      if (await store.compareAndSwap(held?.etag ?? null, JSON.stringify({ version: 1, used: rows }))) return true;
    }
    return false;
  };
}
