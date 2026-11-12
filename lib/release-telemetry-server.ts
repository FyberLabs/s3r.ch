import { version } from "../package.json";
import { releaseColor, releaseVersion, type CrashReport } from "./crash-report";
export function releaseContext(env: Record<string, string | undefined> = process.env) {
  return { version, color:releaseColor(env.S3RCH_RELEASE_COLOR),
    upstreamVersion:releaseVersion(env.S3RCH_UPSTREAM_VERSION), upstreamColor:releaseColor(env.S3RCH_UPSTREAM_COLOR) };
}
/** Fixed fields only. Azure Monitor already collects the App Service console. */
export function createErrorRecorder(write: (line: string) => void = line => console.error(line), now = Date.now) {
  let start = now();
  const counts = {"server-error":0,"browser-crash":0};
  return (kind: "server-error" | "browser-crash", report?: CrashReport): boolean => {
    const at = now();
    if (at < start || at - start >= 60_000) { start = at; counts["server-error"] = counts["browser-crash"] = 0; }
    if (counts[kind] >= 120) return false;
    counts[kind]++;
    const event = {event:"s3rch.error.v1",severity:"Error",kind,release:releaseContext(),
      ...(report ? {browser:report} : {})};
    try { write(JSON.stringify(event)); } catch { return false; }
    return true;
  };
}
export const recordError = createErrorRecorder();
