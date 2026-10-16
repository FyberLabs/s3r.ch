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
  return { ...v, [deviceId]: component(v, deviceId) + 1 };
}
