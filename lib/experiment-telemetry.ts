import { createExperimentEmitter, type ExperimentEventType, type ExperimentPayload } from "./experiment-contract";

type ManualClient = { trackEvent(event: { name: ExperimentEventType; properties: ExperimentPayload }): void; flush(): Promise<void> };
type Factory = (connectionString: string) => Promise<ManualClient>;

/** App Service supplies the existing first-party connection string. Only public
 * Azure ingestion endpoints are supported by this deployment adapter. */
export function validExperimentConnection(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\r\n]/.test(value)) return false;
  const fields = new Map<string, string>();
  for (const part of value.split(";").filter(Boolean)) {
    const index = part.indexOf("=");
    if (index < 1) return false;
    const key = part.slice(0, index).toLowerCase(), content = part.slice(index + 1);
    if (fields.has(key) || !["instrumentationkey", "ingestionendpoint", "liveendpoint", "applicationid"].includes(key)) return false;
    fields.set(key, content);
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(fields.get("instrumentationkey") ?? "") || fields.has("applicationid") && !uuid.test(fields.get("applicationid")!)) return false;
  for (const name of ["ingestionendpoint", "liveendpoint"]) {
    const value = fields.get(name); if (value === undefined) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
          ![".applicationinsights.azure.com", ".livediagnostics.monitor.azure.com", ".services.visualstudio.com"].some(suffix => url.hostname.endsWith(suffix))) return false;
    } catch { return false; }
  }
  return true;
}

export async function createManualExperimentClient(connectionString: string) {
  if (!validExperimentConnection(connectionString)) throw Error("Experiment telemetry unavailable");
  const { TelemetryClient } = await import("applicationinsights");
  const client = new TelemetryClient(connectionString, { useGlobalProviders: false });
  Object.assign(client.config, {
    enableAutoCollectRequests: false, enableAutoCollectDependencies: false,
    enableAutoCollectConsole: false, enableAutoCollectExternalLoggers: false,
    enableAutoCollectExceptions: false, enableAutoCollectPerformance: false,
    enableAutoCollectPreAggregatedMetrics: false, enableAutoCollectHeartbeat: false,
    enableAutoCollectExtendedMetrics: false, enableAutoCollectIncomingRequestAzureFunctions: false,
    enableAutoDependencyCorrelation: false, enableSendLiveMetrics: false,
    enableUseDiskRetryCaching: false, enableInternalDebugLogging: false,
    enableInternalWarningLogging: false,
  });
  client.commonProperties = {};
  client.context.tags = { "ai.cloud.role": "s3rch" };
  return client;
}

/** true means queued to the manual-only SDK, not confirmed ingestion.
 * The injected factory is for offline contracts; production uses the official SDK. */
export function createExperimentTelemetry(connectionString: unknown, factory: Factory = createManualExperimentClient) {
  let pending: Promise<ManualClient> | undefined;
  const configured = validExperimentConnection(connectionString);
  const emit = createExperimentEmitter(async (name, payload) => {
    if (!configured) throw Error("Experiment telemetry unavailable");
    pending ??= Promise.resolve().then(() => factory(connectionString));
    const client = await pending;
    client.trackEvent({ name, properties: payload });
  });
  return Object.freeze({ emit,
    async flush(): Promise<boolean> {
      if (!pending) return false;
      try { await (await pending).flush(); return true; } catch { return false; }
    },
  });
}

let cached: ReturnType<typeof createExperimentTelemetry> | undefined;
/** Lazy process-scoped client; import/build does not read credentials or start telemetry.
 * App Service configuration changes take effect with its normal process restart. */
export function emitExperimentEvent(type: ExperimentEventType, payload: unknown): Promise<boolean> {
  cached ??= createExperimentTelemetry(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  return cached.emit(type, payload);
}
