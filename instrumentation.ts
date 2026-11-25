// Next owns web startup. The identity probe runs in its own worker.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportStartupConfiguration } = await import("./lib/startup-configuration");
    if (reportStartupConfiguration()) {
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
