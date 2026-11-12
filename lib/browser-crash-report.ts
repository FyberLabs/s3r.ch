import { version } from "../package.json";
import { releaseColor, releaseVersion, type CrashKind } from "./crash-report";
export function createBrowserReporter(fetcher: typeof fetch = fetch) {
  let count = 0;
  const loadContext = () => Promise.resolve().then(() => fetcher("/api/telemetry/context",{cache:"no-store",credentials:"omit",redirect:"error",signal:AbortSignal.timeout(3000)}))
    .then(r => r.ok ? r.json() : null).catch(() => null);
  let context: ReturnType<typeof loadContext> | undefined;
  return (kind: CrashKind): void => {
    if (count++ >= 20) return;
    context ??= loadContext();
    void context.then(c => fetcher("/api/telemetry/error", {method:"POST",credentials:"omit",redirect:"error",keepalive:true,
      headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(3000),
      body:JSON.stringify({kind,version,color:releaseColor(c?.color),upstreamVersion:releaseVersion(c?.upstreamVersion),upstreamColor:releaseColor(c?.upstreamColor)})})).catch(() => {});
  };
}
