import { isForumObjectId } from "./identity/forum-check";
import { recoveryObject, recoveryList } from "./identity/forum-recovery-records";

export type InventoryState = Readonly<{ version: 1; operation: string | null; destinations: readonly string[] }>;
export type InventoryStore = {
  read(): Promise<{ text: string; etag: string } | null>;
  /** Atomic conditional write. null expects absence; false means conflict only. */
  compareAndSwap(etag: string | null, text: string): Promise<boolean>;
};
function destinations(input: unknown): readonly string[] {
  const rows = recoveryList(input);
  if (!rows || rows.length > 256 || rows.some(x => typeof x !== "string" || !isForumObjectId(x))) throw Error("invalid destination inventory");
  if (new Set(rows).size !== rows.length) throw Error("duplicate destination");
  return Object.freeze((rows as string[]).slice().sort());
}
function parse(text: string): InventoryState {
  if (typeof text !== "string" || text.length > 131072) throw Error("invalid inventory size");
  const r = recoveryObject(JSON.parse(text));
  if (!r || Object.keys(r).sort().join() !== "destinations,operation,version" || r.version !== 1 ||
      (r.operation !== null && (typeof r.operation !== "string" || !/^[0-9a-f]{32}$/.test(r.operation)))) throw Error("invalid inventory state");
  return Object.freeze({ version: 1, operation: r.operation as string | null, destinations: destinations(r.destinations) });
}
/** Coordination data, not ACL authority or worker-stop evidence. All destinations
 * must be registered BEFORE dispatch, child creation or grant publication. A
 * successful registration is only an inventory reservation, not permission to
 * execute later: consumers still need dispatch fencing and worker drain.
 * There is deliberately no thaw, removal, expiry or missing-state reset.
 */
export function createDelegationInventory(store: InventoryStore) {
  async function read() {
    const saved = await store.read();
    if (!saved || typeof saved.etag !== "string" || !saved.etag || saved.etag === "*") throw Error("missing inventory or ETag");
    return { state: parse(saved.text), etag: saved.etag };
  }
  async function update(change: (state: InventoryState) => InventoryState) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await read(), next = change(saved.state);
      if (next === saved.state) return saved.state;
      if (await store.compareAndSwap(saved.etag, JSON.stringify(next))) return next;
    }
    throw Error("inventory contention; retry with the same operation");
  }
  return Object.freeze({
    async initialize(initial: readonly string[]) {
      // Explicit provisioning only. A missing live registry must never become
      // an empty inventory automatically during freeze/recovery.
      const next: InventoryState = Object.freeze({ version: 1, operation: null, destinations: destinations(initial) });
      await store.compareAndSwap(null, JSON.stringify(next));
      const saved = await read();
      if (JSON.stringify(saved.state) !== JSON.stringify(next)) throw Error("inventory already initialized differently");
      return saved.state;
    },
    async load() { return (await read()).state; },
    async register(destination: string) {
      destinations([destination]);
      return update(state => {
        if (state.operation !== null) throw Error("inventory frozen");
        if (state.destinations.includes(destination)) return state;
        return Object.freeze({ ...state, destinations: destinations([...state.destinations, destination]) });
      });
    },
    async freeze(operation: string) {
      if (typeof operation !== "string" || !/^[0-9a-f]{32}$/.test(operation)) throw Error("invalid operation ID");
      return update(state => {
        if (state.operation === operation) return state;
        if (state.operation !== null) throw Error("another cancellation operation owns inventory");
        return Object.freeze({ ...state, operation });
      });
    },
  });
}
