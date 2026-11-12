import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import { createExperimentEmitter, type ExperimentEventType, type ExperimentPayload } from "./experiment-contract";

type ManualClient = { trackEvent(event: { name: ExperimentEventType; properties: ExperimentPayload }): void | Promise<void>; flush(): Promise<void> };
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
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
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

type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** A bounded, explicit ingestion request avoids SDK background diagnostics and
 * configuration polling. No request metadata or automatic context is serialized. */
export async function createManualExperimentClient(connectionString: string, transport: Transport = fetch) {
  if (!validExperimentConnection(connectionString)) throw Error("Experiment telemetry unavailable");
  const fields = new Map(connectionString.split(";").filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).toLowerCase(), part.slice(index + 1)];
  }));
  const endpoint = new URL("v2/track", fields.get("ingestionendpoint") ?? "https://dc.applicationinsights.azure.com/").href;
  let active = 0;
  return {
    async trackEvent(event: { name: ExperimentEventType; properties: ExperimentPayload }) {
      if (active >= 8) throw Error("Experiment telemetry busy");
      active++;
      try {
        const response = await context.with(ROOT_CONTEXT, () => transport(endpoint, {
          method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(2000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ver: 1, name: "Microsoft.ApplicationInsights.Event", time: new Date().toISOString(),
            sampleRate: 100, iKey: fields.get("instrumentationkey"), tags: { "ai.cloud.role": "s3rch" },
            data: { baseType: "EventData", baseData: { ver: 2, name: event.name, properties: event.properties } } }),
        }));
        // A single-event request must be fully accepted; partial acceptance is failure.
        await response.body?.cancel();
        if (response.status !== 200) throw Error("Experiment telemetry rejected");
      } finally { active--; }
    },
    async flush() { /* Every emit awaits its own bounded request; there is no queue. */ },
  };
}

/** true means the ingestion endpoint accepted the event, not that it is queryable.
 * The injected factory supports offline contract tests. */
export function createExperimentTelemetry(connectionString: unknown, factory: Factory = createManualExperimentClient) {
  let pending: Promise<ManualClient> | undefined;
  const configured = validExperimentConnection(connectionString);
  const emit = createExperimentEmitter(async (name, payload) => {
    if (!configured) throw Error("Experiment telemetry unavailable");
    pending ??= Promise.resolve().then(() => factory(connectionString));
    const client = await pending;
    await context.with(ROOT_CONTEXT, () => client.trackEvent({ name, properties: payload }));
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
