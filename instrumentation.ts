// Next owns web startup. The identity probe runs in its own worker.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIdentityMonitor } = await import("./identity-monitor.cjs");
    startIdentityMonitor();
  }
}

export async function onRequestError() {
  const { recordError } = await import("./lib/release-telemetry-server");
  recordError("server-error");
}
