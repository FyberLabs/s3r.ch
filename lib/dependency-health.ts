/**
 * Optional integrations, reported by /api/health. A missing setting is not an
 * error: the site runs without it and the matching route answers 503.
 * The last hop outcome per service is kept in memory so health can show an
 * integration that is configured but unreachable.
 */
import { readOraclesAttestEnv } from "./oracles-attest";
import { readPaymentsAccessEnv } from "./payments-access";
import { readStaticTurnServer, readTurnAllocateEnv } from "./turn-allocate";

type EnvLike = Record<string, string | undefined>;
export type IntegrationService = "payments" | "oracles" | "turn";
type HopRecord = { ok: boolean; at: string };

const HOPS_KEY = Symbol.for("s3rch.integrationHops");

function hops(): Partial<Record<IntegrationService, HopRecord>> {
  const g = globalThis as { [HOPS_KEY]?: Partial<Record<IntegrationService, HopRecord>> };
  if (!g[HOPS_KEY]) g[HOPS_KEY] = {};
  return g[HOPS_KEY]!;
}

export function recordIntegrationHop(service: IntegrationService, ok: boolean, now = Date.now()): void {
  hops()[service] = { ok, at: new Date(now).toISOString() };
}

export function resetIntegrationHopsForTests(): void {
  delete (globalThis as { [HOPS_KEY]?: unknown })[HOPS_KEY];
}

type ServiceStatus = "not-configured" | "configured" | "ok" | "unreachable";

function serviceStatus(service: IntegrationService, configured: boolean) {
  if (!configured) return { status: "not-configured" as ServiceStatus };
  const last = hops()[service];
  if (!last) return { status: "configured" as ServiceStatus };
  return { status: (last.ok ? "ok" : "unreachable") as ServiceStatus, lastHopAt: last.at };
}

export function panopticonHealth(env: EnvLike = process.env) {
  const services = {
    payments: serviceStatus("payments", readPaymentsAccessEnv(env) !== null),
    oracles: serviceStatus("oracles", readOraclesAttestEnv(env) !== null),
    turn: serviceStatus("turn", readTurnAllocateEnv(env) !== null),
  };
  const statuses = Object.values(services).map((service) => service.status);
  const status = statuses.every((value) => value === "not-configured")
    ? "not-configured"
    : statuses.includes("unreachable")
      ? "degraded"
      : "configured";
  return {
    status,
    services,
    staticTurn: readStaticTurnServer(env) ? "configured" : "not-configured",
  };
}
