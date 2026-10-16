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

/**
 * Marker key set on a vector once compaction has dropped a component from it. Not a device;
 * ignored when comparing.
 */
export const COMPACTED = "@";

/** A key usable as a deviceId. */
export function isDeviceId(key: string): boolean {
  return isSafeKey(key) && key !== COMPACTED;
}

/**
 * A component. A missing one reads as its final counter in the retirement map
 * (`deviceId → final counter` of retired devices) only on a compacted vector; a vector that
 * never dropped a component reads it as 0, since it genuinely predates that device.
 */
function component(v: VersionVector, key: string, retired: VersionVector = {}): number {
  if (Object.hasOwn(v, key)) return v[key]!;
  return Object.hasOwn(v, COMPACTED) && Object.hasOwn(retired, key) ? retired[key]! : 0;
}

export type VVOrder = "equal" | "before" | "after" | "concurrent";

function isCounter(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

export function isVersionVector(value: unknown): value is VersionVector {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => isSafeKey(k) && isCounter(v));
}

/** Order of `a` relative to `b`; missing components that are retired read as their final counter. */
export function compareVV(a: VersionVector, b: VersionVector, retired: VersionVector = {}): VVOrder {
  let aAhead = false;
  let bAhead = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  // A compacted vector also carries every retired device it dropped.
  if (Object.hasOwn(a, COMPACTED) || Object.hasOwn(b, COMPACTED)) for (const k of Object.keys(retired)) keys.add(k);
  keys.delete(COMPACTED);
  for (const key of keys) {
    const x = component(a, key, retired);
    const y = component(b, key, retired);
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

/** Increment this device's component (continuing from its final counter if it was retired). */
export function bumpVV(v: VersionVector, deviceId: string, retired: VersionVector = {}): VersionVector {
  if (!isDeviceId(deviceId)) throw new Error("deviceId is empty or reserved");
  const n = component(v, deviceId, retired);
  if (n >= Number.MAX_SAFE_INTEGER) throw new Error("version counter is exhausted");
  return { ...v, [deviceId]: n + 1 };
}

/**
 * Compaction: drop components that equal their retired device's final counter. Comparisons
 * read them back from the retirement map, so ordering is unchanged.
 */
export function compactVV(v: VersionVector, retired: VersionVector): VersionVector {
  const out: VersionVector = {};
  let compacted = Object.hasOwn(v, COMPACTED);
  for (const [k, n] of Object.entries(v)) {
    if (k === COMPACTED) continue;
    if (Object.hasOwn(retired, k) && retired[k] === n) compacted = true;
    else out[k] = n;
  }
  if (compacted) out[COMPACTED] = 1;
  return out;
}

/**
 * Component-wise maximum under a retirement map: a missing retired component counts as its
 * final counter, so `{ r: 3 }` joined with a vector that dropped `r` (final 5) reads as 5.
 * The result is compacted.
 */
export function joinVV(retired: VersionVector, ...vectors: VersionVector[]): VersionVector {
  const out: VersionVector = {};
  const keys = new Set(vectors.flatMap((v) => Object.keys(v)));
  if (keys.has(COMPACTED)) for (const k of Object.keys(retired)) keys.add(k);
  keys.delete(COMPACTED);
  for (const key of keys) {
    const n = Math.max(...vectors.map((v) => component(v, key, retired)));
    if (n > 0) out[key] = n;
  }
  return compactVV(out, retired);
}
