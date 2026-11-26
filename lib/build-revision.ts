export function buildRevision(): string | null {
  const revision = process.env.APP_BUILD_REVISION ?? "";
  return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}
