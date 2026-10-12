/**
 * Server hop: s3r.ch SIWE session → Panopticon TURN allocate.
 *
 * Contract: FyberLabs/panopticon `products/turn/docs/turn-allocate-v0.md`.
 * `POST /api/v1/turn/allocate` → `{ iceServers, expiresAt }`.
 *
 * Env (server-only, empty = STUN-only):
 *   PANOPTICON_TURN_BASE   origin or origin+/api/v1[/turn]
 *   PANOPTICON_TENANT_ID   marketplace tenant UUID (`X-Tenant-ID`)
 *   PANOPTICON_API_KEY     product API key (`X-Api-Key`). Never NEXT_PUBLIC_*.
 *
 * Optional static fallback (server-only), used when the hop above is not
 * configured or fails:
 *   S3RCH_TURN_URLS         comma-separated turn:/turns:/stun: URLs
 *   S3RCH_TURN_USERNAME     required when a turn: URL is listed
 *   S3RCH_TURN_CREDENTIAL   required when a turn: URL is listed
 *
 * Never Gun. Never localStorage. Never the long-lived TURN secret of the
 * allocate service. A static credential is handed to signed-in browsers, so
 * use one scoped to this relay.
 * Fail soft: nothing configured / 401 / 503 / network / bad JSON → caller keeps STUN.
 */

import { iceServerUrls } from "./gun-webrtc";

export const PANOPTICON_ALLOCATE_PATH = "/api/v1/turn/allocate";
export const DEFAULT_ALLOCATE_TTL_SEC = 300;
export const DEFAULT_CLIENT_HINT = "s3rch-peer";
export const ALLOCATE_FETCH_MS = 8_000;
export const ALLOCATE_USER_AGENT = "s3r.ch-turn-allocate/0.1 (Fyber Labs)";

export const ENV_TURN_BASE = "PANOPTICON_TURN_BASE";
export const ENV_TENANT_ID = "PANOPTICON_TENANT_ID";
export const ENV_API_KEY = "PANOPTICON_API_KEY";
export const ENV_STATIC_TURN_URLS = "S3RCH_TURN_URLS";
export const ENV_STATIC_TURN_USERNAME = "S3RCH_TURN_USERNAME";
export const ENV_STATIC_TURN_CREDENTIAL = "S3RCH_TURN_CREDENTIAL";

export type EnvLike = Record<string, string | undefined>;

export type TurnAllocateEnv = {
  base: string;
  tenantId: string;
  apiKey: string;
};

export type TurnIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type TurnAllocateOk = {
  iceServers: TurnIceServer[];
  expiresAt: string;
};

export type AllocateRouteResult =
  | { status: 200; body: TurnAllocateOk }
  | { status: 401; body: { error: string } }
  | { status: 503; body: { error: string } };

export function trimEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * All three must be non-empty. Base must be http(s). Localhost is allowed
 * so a lab Panopticon on :8012 works. Empty / invalid = not configured.
 */
export function readTurnAllocateEnv(env: EnvLike = process.env): TurnAllocateEnv | null {
  const tenantId = trimEnv(env[ENV_TENANT_ID]);
  const apiKey = trimEnv(env[ENV_API_KEY]);
  const rawBase = trimEnv(env[ENV_TURN_BASE]);
  if (!tenantId || !apiKey || !rawBase) return null;
  const base = normalizeTurnBase(rawBase);
  if (!base) return null;
  return { base, tenantId, apiKey };
}

export function normalizeTurnBase(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Join operator base to the fixed allocate path. */
export function panopticonAllocateUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith(PANOPTICON_ALLOCATE_PATH)) return trimmed;
  if (trimmed.endsWith("/api/v1/turn")) return `${trimmed}/allocate`;
  if (trimmed.endsWith("/api/v1")) return `${trimmed}/turn/allocate`;
  return `${trimmed}${PANOPTICON_ALLOCATE_PATH}`;
}

export function allocateHopHeaders(cfg: TurnAllocateEnv): Record<string, string> {
  return {
    "X-Tenant-ID": cfg.tenantId,
    "X-Api-Key": cfg.apiKey,
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": ALLOCATE_USER_AGENT,
  };
}

/** Panopticon username id: `[A-Za-z0-9._-]`, max 64. */
export function sanitizeClientHint(raw: string | undefined): string {
  const cleaned = (raw ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return cleaned || DEFAULT_CLIENT_HINT;
}

export function allocateRequestBody(clientHint?: string): {
  ttlSec: number;
  clientHint: string;
} {
  return {
    ttlSec: DEFAULT_ALLOCATE_TTL_SEC,
    clientHint: sanitizeClientHint(clientHint),
  };
}

function iceUrlHost(url: string): string | null {
  const match = url.match(/^(stun|stuns|turn|turns):([^:?]+)(?::\d+)?(?:\?.*)?$/i);
  if (!match) return null;
  return match[2].replace(/^\[|\]$/g, "").toLowerCase();
}

function isBlockedRelayHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".ts.net") ||
    host === "::1"
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isPublicIceUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  const host = iceUrlHost(url);
  if (!host) return false;
  return !isBlockedRelayHost(host);
}

export function iceServerHasTurn(server: {
  urls?: string | string[];
  url?: string;
}): boolean {
  return iceServerUrls(server).some(
    (url) => url.startsWith("turn:") || url.startsWith("turns:"),
  );
}

export function admitIceServer(raw: unknown): TurnIceServer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    urls?: unknown;
    url?: unknown;
    username?: unknown;
    credential?: unknown;
  };
  const urls = iceServerUrls({
    urls: row.urls as string | string[] | undefined,
    url: typeof row.url === "string" ? row.url : undefined,
  });
  if (urls.length === 0) return null;
  if (!urls.every(isPublicIceUrl)) return null;
  const admitted: TurnIceServer = {
    urls: urls.length === 1 ? urls[0] : urls,
  };
  if (typeof row.username === "string" && row.username) {
    admitted.username = row.username;
  }
  if (typeof row.credential === "string" && row.credential) {
    admitted.credential = row.credential;
  }
  if (iceServerHasTurn(admitted) && (!admitted.username || !admitted.credential)) {
    return null;
  }
  return admitted;
}

export function parseAllocateResponse(body: unknown): TurnAllocateOk | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { iceServers?: unknown; expiresAt?: unknown };
  if (!Array.isArray(row.iceServers) || row.iceServers.length === 0) return null;
  if (typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt))) {
    return null;
  }
  const iceServers: TurnIceServer[] = [];
  for (const server of row.iceServers) {
    const admitted = admitIceServer(server);
    if (!admitted) return null;
    iceServers.push(admitted);
  }
  return { iceServers, expiresAt: row.expiresAt };
}

export async function hopPanopticonAllocate(input: {
  cfg: TurnAllocateEnv;
  clientHint?: string;
  fetchImpl?: typeof fetch;
}): Promise<TurnAllocateOk | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = panopticonAllocateUrl(input.cfg.base);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: allocateHopHeaders(input.cfg),
      body: JSON.stringify(allocateRequestBody(input.clientHint)),
      signal: AbortSignal.timeout(ALLOCATE_FETCH_MS),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return null;
    return parseAllocateResponse(await response.json());
  } catch {
    return null;
  }
}

/**
 * Static relay from S3RCH_TURN_*. Null when unset or when any URL is not a
 * public stun:/turn: URL, or a turn: URL has no username and credential.
 */
export function readStaticTurnServer(env: EnvLike = process.env): TurnIceServer | null {
  const urls = trimEnv(env[ENV_STATIC_TURN_URLS])
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) return null;
  return admitIceServer({
    urls,
    username: trimEnv(env[ENV_STATIC_TURN_USERNAME]) || undefined,
    credential: trimEnv(env[ENV_STATIC_TURN_CREDENTIAL]) || undefined,
  });
}

function staticAllocation(env: EnvLike | undefined, now: number): TurnAllocateOk | null {
  const server = readStaticTurnServer(env);
  if (!server) return null;
  // Same lifetime as an allocation so the browser asks again and picks up rotation.
  return {
    iceServers: [server],
    expiresAt: new Date(now + DEFAULT_ALLOCATE_TTL_SEC * 1000).toISOString(),
  };
}

/**
 * Next-route body. Unsigned → 401. Allocate hop first, then the static relay.
 * Neither available → 503 and the browser stays STUN-only.
 * Never returns the product API key.
 */
export async function sessionGatedAllocate(input: {
  sessionAddress: string | null;
  env?: EnvLike;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<AllocateRouteResult> {
  if (!input.sessionAddress) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const cfg = readTurnAllocateEnv(env);
  if (!cfg) {
    const fallback = staticAllocation(env, now);
    if (fallback) return { status: 200, body: fallback };
    return { status: 503, body: { error: "turn-unconfigured" } };
  }
  const allocated = await hopPanopticonAllocate({
    cfg,
    clientHint: input.sessionAddress,
    fetchImpl: input.fetchImpl,
  });
  if (!allocated) {
    const fallback = staticAllocation(env, now);
    if (fallback) return { status: 200, body: fallback };
    return { status: 503, body: { error: "turn-unavailable" } };
  }
  return { status: 200, body: allocated };
}
