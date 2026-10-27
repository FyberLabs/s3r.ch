/**
 * Decide whether X.Y.Z may be pushed.
 * An existing tag is reused when its version label matches. It is never replaced.
 */

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * @param {{ digest?: string, versionLabel?: string } | null | undefined} existing
 * @param {string} version
 * @returns {{ action: "push" } | { action: "reuse", digest: string }}
 */
export function versionTagPlan(existing, version) {
  if (existing == null) return { action: "push" };
  const digest = String(existing.digest ?? "").trim();
  const label = String(existing.versionLabel ?? "").trim();
  if (!DIGEST.test(digest)) {
    throw new Error("published version tag is missing a sha256 digest");
  }
  if (label !== version) {
    throw new Error(`refusing to replace ${version}; published tag is ${label || "unlabeled"}`);
  }
  return { action: "reuse", digest };
}
