import type { IdentityHealthStatus } from "./identity-health.cjs";

export type ProbeResult = { ok: boolean; message?: string };
export const RETRY_MIN_MS: number;
export const RETRY_MAX_MS: number;
export function classifyFailure(error: unknown): { status: Extract<IdentityHealthStatus, "unavailable" | "invalid">; reason: string };
export function retryDelay(attempt: number): number;
export function probeInWorker(timeoutMs?: number): Promise<ProbeResult>;
export function startIdentityMonitor(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  probe?: () => Promise<ProbeResult>;
  log?: Pick<Console, "log" | "error">;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: never) => void;
  now?: () => number;
}): { stop(): void; done: Promise<void> };
