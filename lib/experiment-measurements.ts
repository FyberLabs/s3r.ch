import { AsyncLocalStorage } from "node:async_hooks";
import { createExperimentDependencyObserver } from "./experiment-dependency-observer";
import { createMeasurementPublisher, privateMeasurementSecret, type MeasurementRow } from "./experiment-measurement-publisher";

type Scope = { experiment: string; variant: string; current(): boolean; signal?: AbortSignal };

/** Only a verified runtime callback installs scope. No browser handler can report rows. */
export function measurementScope(observer: ReturnType<typeof createExperimentDependencyObserver>, publish: (rows: readonly MeasurementRow[]) => boolean = () => false) {
  const storage = new AsyncLocalStorage<Scope & { accepted: boolean; pending: (readonly MeasurementRow[])[] }>();
  return Object.freeze({
    async run<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
      if (scope.experiment !== "landing-message" || !["control", "create"].includes(scope.variant) || !scope.current())
        return Promise.reject(Error("Measurement context unavailable"));
      const context = { ...scope, accepted: true, pending: [] as (readonly MeasurementRow[])[] };
      try { return await storage.run(context, work); }
      finally {
        // A successfully returned ledger must pass the native consent check
        // before its observations leave this scope. Any observed revocation or
        // invalid ledger invalidates the whole operation, including earlier rows.
        try { if (context.accepted && context.current()) for (const rows of context.pending) publish(rows); }
        catch { /* Measurement delivery never changes the native result. */ }
        context.pending.length = 0;
      }
    },
    stage(rows: readonly MeasurementRow[]): boolean {
      const scope = storage.getStore();
      if (!scope || !scope.accepted || !scope.current() || scope.pending.length >= 64) return false;
      scope.pending.push(rows); return true;
    },
    accepted(allowed: boolean) {
      const scope = storage.getStore();
      if (scope && !allowed) { scope.accepted = false; scope.pending.length = 0; }
    },
    read(name: string, signal?: AbortSignal): Promise<Response | null> {
      const scope = storage.getStore();
      if (!scope) return Promise.resolve(null);
      return observer.read({ variant: scope.variant, recordName: name, current: scope.current, signal: signal && scope.signal ? AbortSignal.any([signal, scope.signal]) : signal ?? scope.signal });
    },
  });
}

export async function createS3rchMeasurements(env: Record<string, string | undefined>, transport: typeof fetch = fetch) {
  if (env.S3RCH_MEASUREMENTS_ENABLED !== "1") return undefined;
  const tenant = env.S3RCH_EXPERIMENT_TENANT;
  if (!tenant || tenant !== env.S3RCH_MEASUREMENTS_TENANT ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(tenant) || tenant === "00000000-0000-0000-0000-000000000000")
    throw Error("Measurement tenant binding required");
  const secret = await privateMeasurementSecret(env.S3RCH_MEASUREMENTS_SECRET_FILE ?? "");
  const relaySecret = await privateMeasurementSecret(env.S3RCH_MEASUREMENTS_RELAY_SECRET_FILE ?? "");
  if (secret === relaySecret || [env.S3RCH_SESSION_SIGNING_KEY, env.S3RCH_MEDIA_SIGNING_KEY, env.S3RCH_EXPERIMENT_SECRET, ...(env.S3RCH_EXPERIMENT_PREVIOUS_SECRETS?.split(",") ?? []), env.S3RCH_EXPERIMENT_CACHE_KEY, env.S3RCH_EXPERIMENT_OUTBOX_KEY].some(key => key === secret || key === relaySecret))
    throw Error("Separate measurement credentials required");
  const publisher = createMeasurementPublisher({ endpoint: env.S3RCH_MEASUREMENTS_INGESTION_ENDPOINT ?? "",
    rule: env.S3RCH_MEASUREMENTS_DCR_ID ?? "", directory: env.S3RCH_MEASUREMENTS_DIRECTORY ?? "",
    clientId: env.S3RCH_MEASUREMENTS_CLIENT_ID ?? "", secret }, transport);
  let scope: ReturnType<typeof measurementScope>;
  const observer = createExperimentDependencyObserver({ enabled: true, transport, publish: rows => scope.stage(rows),
    binding: { relayOrigin: env.S3RCH_MEASUREMENTS_RELAY_ORIGIN ?? "", relaySecret,
      experiment: "landing-message", variants: ["control", "create"], operation: "s3rch-outbox-read",
      recordPrefix: "s3rch-outbox-", sampleEvery: Number(env.S3RCH_MEASUREMENTS_SAMPLE_EVERY ?? "100") } });
  scope = measurementScope(observer, publisher.publish);
  return Object.freeze({ ...scope, close() { observer.close(); publisher.close(); } });
}
