/**
 * Version vectors for Views (docs/views.md §5). Each View carries `deviceId → counter`,
 * bumped on every local edit. Ordering never uses wall-clock time.
 */
export type VersionVector = Record<string, number>;

/** Keys usable as plain-object keys without colliding with Object.prototype members. */
export function isSafeKey(key: string): boolean {
  // "_" is reserved for Gun node metadata.
  return key !== "" && key !== "_" && key !== "__proto__" && !(key in Object.prototype);
}

function component(v: VersionVector, key: string): number {
  return Object.hasOwn(v, key) ? v[key]! : 0;
}

export type VVOrder = "equal" | "before" | "after" | "concurrent";

function isCounter(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export function isVersionVector(value: unknown): value is VersionVector {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => isSafeKey(k) && isCounter(v));
}

/** Order of `a` relative to `b`. */
export function compareVV(a: VersionVector, b: VersionVector): VVOrder {
  let aAhead = false;
  let bAhead = false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = component(a, key);
    const y = component(b, key);
    if (x > y) aAhead = true;
    else if (y > x) bAhead = true;
  }
  if (aAhead && bAhead) return "concurrent";
  if (aAhead) return "after";
  if (bAhead) return "before";
  return "equal";
}

/** Component-wise maximum. */
export function maxVV(...vectors: VersionVector[]): VersionVector {
  const out: VersionVector = {};
  for (const v of vectors) for (const [k, n] of Object.entries(v)) out[k] = Math.max(component(out, k), n);
  return out;
}

/** Increment this device's component. */
export function bumpVV(v: VersionVector, deviceId: string): VersionVector {
  if (!isSafeKey(deviceId)) throw new Error("deviceId is empty or reserved");
  const n = component(v, deviceId);
  if (n >= Number.MAX_SAFE_INTEGER) throw new Error("version counter is exhausted");
  return { ...v, [deviceId]: n + 1 };
}

/**
 * A causal stamp. `vv` holds live components. `folded` holds components this stamp
 * compacted, with the exact counter it folded. `foldedAll` means this stamp compacted
 * every entry of the retirement map it was saved with; expand it with that map before
 * comparing it to a stamp saved with a different map.
 */
export type Causal = { vv: VersionVector; folded?: VersionVector; foldedAll?: true };

/** Read one component. A device this stamp never saw, and did not fold, is 0. */
export function readCausal(c: Causal, key: string, retirements?: VersionVector): number {
  if (Object.hasOwn(c.vv, key)) return c.vv[key]!;
  if (c.folded && Object.hasOwn(c.folded, key)) return c.folded[key]!;
  if (c.foldedAll && retirements && Object.hasOwn(retirements, key)) return retirements[key]!;
  return 0;
}

function packCausal(c: Causal): Causal {
  const out: Causal = { vv: c.vv };
  if (c.folded && Object.keys(c.folded).length) out.folded = c.folded;
  if (c.foldedAll) out.foldedAll = true;
  return out;
}

/** Replace `foldedAll` with the exact counters of `retirements`. */
export function expandFolded(c: Causal, retirements: VersionVector): Causal {
  const vv = { ...c.vv };
  if (!c.foldedAll) return packCausal({ vv, folded: c.folded ? { ...c.folded } : undefined });
  const folded = { ...(c.folded ?? {}) };
  for (const [k, n] of Object.entries(retirements)) {
    if (!Object.hasOwn(vv, k)) folded[k] = Math.max(folded[k] ?? 0, n);
  }
  return packCausal({ vv, folded });
}

/** Order of `a` relative to `b`, using folded counters. Expand `foldedAll` before calling. */
export function compareCausal(a: Causal, b: Causal): VVOrder {
  let aAhead = false;
  let bAhead = false;
  const keys = new Set([...Object.keys(a.vv), ...Object.keys(b.vv), ...Object.keys(a.folded ?? {}), ...Object.keys(b.folded ?? {})]);
  for (const key of keys) {
    const x = readCausal(a, key);
    const y = readCausal(b, key);
    if (x > y) aAhead = true;
    else if (y > x) bAhead = true;
  }
  if (aAhead && bAhead) return "concurrent";
  if (aAhead) return "after";
  if (bAhead) return "before";
  return "equal";
}

/** `have` is equal to or after `need`. */
export function coversCausal(have: Causal, need: Causal): boolean {
  const order = compareCausal(need, have);
  return order === "before" || order === "equal";
}

/** Component-wise maximum, materialized into `vv`. Folded counters are included. */
export function maxCausal(...cs: (Causal | undefined)[]): Causal {
  const keys = new Set<string>();
  for (const c of cs) {
    if (!c) continue;
    for (const k of Object.keys(c.vv)) keys.add(k);
    if (c.folded) for (const k of Object.keys(c.folded)) keys.add(k);
  }
  const vv: VersionVector = {};
  for (const key of keys) {
    let n = 0;
    for (const c of cs) if (c) n = Math.max(n, readCausal(c, key));
    if (n > 0) vv[key] = n;
  }
  return { vv };
}

export function materializeCausal(c: Causal): VersionVector {
  return maxCausal(c).vv;
}

/**
 * Move a component into `folded` when this stamp has observed the retired counter exactly.
 * A stamp that never had the component is left alone, so it keeps reading that device as 0.
 * A higher local counter stays live: the device was not finished at the retired value.
 */
export function compactCausal(c: Causal, retirements: VersionVector): Causal {
  const vv = { ...c.vv };
  const folded = { ...(c.folded ?? {}) };
  for (const [id, finalCounter] of Object.entries(retirements)) {
    if (!Object.hasOwn(vv, id) && !Object.hasOwn(folded, id)) continue;
    const mine = Object.hasOwn(vv, id) ? vv[id]! : folded[id]!;
    if (mine !== finalCounter) {
      if (mine > finalCounter) {
        vv[id] = mine;
        delete folded[id];
      }
      continue;
    }
    delete vv[id];
    folded[id] = finalCounter;
  }
  return packCausal({ vv, folded });
}

/**
 * When `folded` is exactly `retirements`, store a marker instead of repeating the map.
 * An empty map is never collapsed: the marker would adopt every later retirement.
 */
export function collapseFolded(c: Causal, retirements: VersionVector): Causal {
  const keys = Object.keys(retirements);
  const folded = c.folded ?? {};
  const same =
    keys.length > 0 &&
    keys.every((k) => folded[k] === retirements[k]) &&
    Object.keys(folded).every((k) => Object.hasOwn(retirements, k)) &&
    Object.keys(c.vv).every((k) => !Object.hasOwn(retirements, k));
  if (!same) return packCausal({ vv: { ...c.vv }, folded: c.folded });
  const vv = { ...c.vv };
  for (const k of keys) delete vv[k];
  return packCausal({ vv, foldedAll: true });
}

/**
 * Component-wise maximum of retirement maps, then (only if asked) a deterministic cap.
 * The cap is applied to the full union, so input order does not change the result.
 * Ties keep the lower device id. Highest counters are kept.
 */
export function unionRetirements(maps: VersionVector[], cap?: number): VersionVector {
  const all: VersionVector = {};
  for (const map of maps) {
    for (const [k, n] of Object.entries(map)) {
      if (!isSafeKey(k) || !isCounter(n)) continue;
      all[k] = Math.max(all[k] ?? 0, n);
    }
  }
  if (cap === undefined || Object.keys(all).length <= cap) return all;
  const ranked = Object.keys(all).sort((a, b) => all[b]! - all[a]! || (a < b ? -1 : a > b ? 1 : 0));
  const out: VersionVector = {};
  for (const k of ranked.slice(0, cap)) out[k] = all[k]!;
  return out;
}
