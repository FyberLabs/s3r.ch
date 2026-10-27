/**
 * Decide whether a moving tag (X.Y or latest) may point at this release.
 * Equal versions refresh the alias. Older versions do not replace newer ones.
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(value) {
  const match = SEMVER.exec(String(value ?? "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Positive when left is newer, zero when equal, negative when left is older. */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    throw new Error(`semver comparison needs X.Y.Z values, got ${left} and ${right}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * @param {string | null | undefined} current version already on the alias, or null when the alias is absent
 * @param {string} candidate version being published
 */
export function shouldAdvanceAlias(current, candidate) {
  if (!parseSemver(candidate)) {
    throw new Error(`candidate ${candidate} is not X.Y.Z`);
  }
  if (current == null || String(current).trim() === "") return true;
  return compareSemver(candidate, current) >= 0;
}
