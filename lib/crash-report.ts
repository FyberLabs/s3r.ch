export type CrashKind = "browser-error" | "unhandled-rejection" | "render-error";
export type ReleaseColor = "blue" | "green" | "test" | "production" | null;
export type CrashReport = { kind: CrashKind; version: string; color: ReleaseColor; upstreamVersion: string | null; upstreamColor: ReleaseColor };
export const releaseVersion = (value: unknown): string | null => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/.test(value) ? value : null;
export const releaseColor = (value: unknown): ReleaseColor => ["blue", "green", "test", "production"].includes(value as string) ? value as ReleaseColor : null;
export function parseCrashReport(value: unknown): CrashReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "color,kind,upstreamColor,upstreamVersion,version" ||
      !["browser-error", "unhandled-rejection", "render-error"].includes(v.kind as string) ||
      !releaseVersion(v.version) || (v.color !== null && !releaseColor(v.color)) ||
      (v.upstreamColor !== null && !releaseColor(v.upstreamColor)) ||
      (v.upstreamVersion !== null && !releaseVersion(v.upstreamVersion))) return null;
  return {kind:v.kind as CrashKind,version:v.version as string,color:v.color as ReleaseColor,
    upstreamVersion:v.upstreamVersion as string | null,upstreamColor:v.upstreamColor as ReleaseColor};
}
