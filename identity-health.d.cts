import type { IdentityBlobClient } from "./identity-blob.cjs";

export type IdentityHealthStatus = "unchecked" | "ok" | "checking" | "unavailable" | "invalid";

export type IdentityHealth = {
  status: IdentityHealthStatus;
  reason: string | null;
  checkedAt: string | null;
  attempts: number;
  nextRetryAt: string | null;
};


export function identityState(): IdentityHealth & { generation: number };
export function setIdentityHealth(status: IdentityHealthStatus, reason?: string | null, now?: number): IdentityHealth;
export function identityHealth(): IdentityHealth;
export function identityGeneration(): number;
export function identityWritable(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean;
export function resetIdentityHealthForTests(status?: IdentityHealthStatus): void;
export function setIdentityClient(client: IdentityBlobClient | null): void;
export function identityClient(): IdentityBlobClient | null;
