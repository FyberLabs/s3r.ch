// Next owns web startup. The identity probe runs in its own worker.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportStartupConfiguration } = await import("./lib/startup-configuration");
    reportStartupConfiguration();
    if (process.env.S3RCH_RELEASE_COLOR === "test" || process.env.S3RCH_RELEASE_COLOR === "staging" ||
        process.env.S3RCH_RELEASE_COLOR === "production") {
      void import("./lib/acl-statement-source-server")
        .then(({ observeStartupStatementKey }) => observeStartupStatementKey())
        .catch(() => {});
    }
    const { startIdentityMonitor } = await import("./identity-monitor.cjs");
    startIdentityMonitor();
    const { startRoomWebhookWorker } = await import("./lib/room-webhook-server");
    startRoomWebhookWorker();
  }
}

export async function onRequestError() {
  const { recordError } = await import("./lib/release-telemetry-server");
  recordError("server-error");
}
