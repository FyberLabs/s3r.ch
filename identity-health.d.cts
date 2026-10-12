export type IdentityHealthStatus = "unchecked" | "ok" | "checking" | "unavailable" | "invalid";

export type IdentityHealth = {
  status: IdentityHealthStatus;
  reason: string | null;
  checkedAt: string | null;
  attempts: number;
  nextRetryAt: string | null;
};

export type ProbeResult = { ok: boolean; message?: string };

export const RETRY_MIN_MS: number;
export const RETRY_MAX_MS: number;
export function setIdentityHealth(status: IdentityHealthStatus, reason?: string | null, now?: number): IdentityHealth;
export function identityHealth(): IdentityHealth;
export function identityGeneration(): number;
export function identityWritable(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean;
export function classifyFailure(error: unknown): { status: "unavailable" | "invalid"; reason: string };
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
export function resetIdentityHealthForTests(status?: IdentityHealthStatus): void;
