/**
 * Server hop: s3r.ch SIWE session → Panopticon oracles attest v0.
 *
 * Contract: FyberLabs/panopticon `products/oracles/docs/oracles-attest-v0.md`.
 * `POST /api/v1/oracles/v0/attest` → `{ ok, kind, subject, status, observedAt, digest, upstream }`.
 *
 * Env (server-only, empty = no hop):
 *   PANOPTICON_ORACLES_BASE  origin or origin+/api/v1[/oracles[/v0]]
 *   PANOPTICON_TENANT_ID     marketplace tenant UUID (`X-Tenant-ID`)
 *   PANOPTICON_API_KEY       product API key (`X-Api-Key`). Never NEXT_PUBLIC_*.
 *
 * Never Gun. Never localStorage. Never a grant from a missing digest.
 * Fail soft: missing env / 401 / 503 / network / bad JSON → caller keeps
 * browser-first SIWE / ENS / ERC-1271. Plane `ok: false` is HTTP 200.
 */

export const PANOPTICON_ATTEST_PATH = "/api/v1/oracles/v0/attest";
export const DEFAULT_CLIENT_HINT = "s3rch-next";
export const ATTEST_FETCH_MS = 8_000;
export const ATTEST_USER_AGENT = "s3r.ch-oracles-attest/0.1 (Fyber Labs)";
export const SUBJECT_MAX_LEN = 256;
export const CLIENT_HINT_MAX_LEN = 128;

export const ENV_ORACLES_BASE = "PANOPTICON_ORACLES_BASE";
export const ENV_TENANT_ID = "PANOPTICON_TENANT_ID";
export const ENV_API_KEY = "PANOPTICON_API_KEY";

export const ATTEST_KINDS = ["public_attestation", "public_relay"] as const;
export const ATTEST_STATUSES = [
  "observed",
  "not_found",
  "unreachable",
  "error",
] as const;

export type EnvLike = Record<string, string | undefined>;

export type OraclesAttestEnv = {
  base: string;
  tenantId: string;
  apiKey: string;
};

export type AttestKind = (typeof ATTEST_KINDS)[number];
export type AttestStatus = (typeof ATTEST_STATUSES)[number];

export type OraclesAttestRequest = {
  kind: AttestKind;
  subject: string;
  clientHint: string;
};

export type OraclesAttestBody = {
  ok: boolean;
  kind: AttestKind;
  subject: string;
  status: AttestStatus;
  observedAt: string;
  digest: string | null;
  upstream: string;
};

export type AttestRouteResult =
  | { status: 200; body: OraclesAttestBody }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 503; body: { error: string } };

const IDENTIFIER_CHARS = /^[A-Za-z0-9:._/-]+$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

export function trimEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * All three must be non-empty. Base must be http(s). Localhost is allowed
 * so a lab Panopticon on :8013 works. Empty / invalid = not configured.
 */
export function readOraclesAttestEnv(env: EnvLike = process.env): OraclesAttestEnv | null {
  const tenantId = trimEnv(env[ENV_TENANT_ID]);
  const apiKey = trimEnv(env[ENV_API_KEY]);
  const rawBase = trimEnv(env[ENV_ORACLES_BASE]);
  if (!tenantId || !apiKey || !rawBase) return null;
  const base = normalizeOraclesBase(rawBase);
  if (!base) return null;
  return { base, tenantId, apiKey };
}

export function normalizeOraclesBase(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Join operator base to the locked attest path. */
export function panopticonAttestUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith(PANOPTICON_ATTEST_PATH)) return trimmed;
  if (trimmed.endsWith("/api/v1/oracles/v0")) return `${trimmed}/attest`;
  if (trimmed.endsWith("/api/v1/oracles")) return `${trimmed}/v0/attest`;
  if (trimmed.endsWith("/api/v1")) return `${trimmed}/oracles/v0/attest`;
  return `${trimmed}${PANOPTICON_ATTEST_PATH}`;
}

export function attestHopHeaders(cfg: OraclesAttestEnv): Record<string, string> {
  return {
    "X-Tenant-ID": cfg.tenantId,
    "X-Api-Key": cfg.apiKey,
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": ATTEST_USER_AGENT,
  };
}

/** Integrator label. Length only, matching plane v0. */
export function sanitizeClientHint(raw: string | undefined): string {
  const cleaned = (raw ?? "").trim().slice(0, CLIENT_HINT_MAX_LEN);
  return cleaned || DEFAULT_CLIENT_HINT;
}

function isBlockedRelayHost(host: string): boolean {
  const lowered = host.trim().toLowerCase().replace(/\.$/, "");
  if (!lowered) return true;
  if (
    lowered === "localhost" ||
    lowered === "localhost.localdomain" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".ts.net") ||
    lowered.endsWith(".tailscale.net") ||
    lowered === "::1"
  ) {
    return true;
  }
  const ipv4 = lowered.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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

export function isPublicHttpsSubject(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (!url.hostname) return false;
  return !isBlockedRelayHost(url.hostname);
}

export function sanitizeAttestSubject(kind: AttestKind, subject: string): string | null {
  const raw = subject.trim();
  if (!raw || raw.length > SUBJECT_MAX_LEN) return null;
  if ([...raw].some((ch) => /\s/.test(ch))) return null;
  if (raw.includes("://")) {
    if (!isPublicHttpsSubject(raw)) return null;
    return raw;
  }
  if (kind === "public_relay") return null;
  if (!IDENTIFIER_CHARS.test(raw)) return null;
  return raw;
}

export function parseAttestRequest(body: unknown): OraclesAttestRequest | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { kind?: unknown; subject?: unknown; clientHint?: unknown };
  if (row.kind !== "public_attestation" && row.kind !== "public_relay") return null;
  if (typeof row.subject !== "string") return null;
  const subject = sanitizeAttestSubject(row.kind, row.subject);
  if (!subject) return null;
  const clientHint =
    typeof row.clientHint === "string" || row.clientHint === undefined
      ? sanitizeClientHint(row.clientHint)
      : null;
  if (!clientHint) return null;
  return { kind: row.kind, subject, clientHint };
}

function isAttestKind(value: unknown): value is AttestKind {
  return value === "public_attestation" || value === "public_relay";
}

function isAttestStatus(value: unknown): value is AttestStatus {
  return (
    value === "observed" ||
    value === "not_found" ||
    value === "unreachable" ||
    value === "error"
  );
}

export function parseAttestResponse(body: unknown): OraclesAttestBody | null {
  if (!body || typeof body !== "object") return null;
  const row = body as {
    ok?: unknown;
    kind?: unknown;
    subject?: unknown;
    status?: unknown;
    observedAt?: unknown;
    digest?: unknown;
    upstream?: unknown;
  };
  if (typeof row.ok !== "boolean") return null;
  if (!isAttestKind(row.kind)) return null;
  if (typeof row.subject !== "string" || !row.subject) return null;
  if (!isAttestStatus(row.status)) return null;
  if (typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))) {
    return null;
  }
  if (typeof row.upstream !== "string" || !row.upstream) return null;
  if (row.ok !== (row.status === "observed")) return null;
  let digest: string | null = null;
  if (row.digest !== null && row.digest !== undefined) {
    if (typeof row.digest !== "string" || !DIGEST_RE.test(row.digest)) return null;
    digest = row.digest;
  }
  if (row.ok && !digest) return null;
  if (!row.ok && digest) return null;
  return {
    ok: row.ok,
    kind: row.kind,
    subject: row.subject,
    status: row.status,
    observedAt: row.observedAt,
    digest,
    upstream: row.upstream,
  };
}

export async function hopPanopticonAttest(input: {
  cfg: OraclesAttestEnv;
  request: OraclesAttestRequest;
  fetchImpl?: typeof fetch;
}): Promise<OraclesAttestBody | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = panopticonAttestUrl(input.cfg.base);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: attestHopHeaders(input.cfg),
      body: JSON.stringify({
        kind: input.request.kind,
        subject: input.request.subject,
        clientHint: input.request.clientHint,
      }),
      signal: AbortSignal.timeout(ATTEST_FETCH_MS),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return null;
    return parseAttestResponse(await response.json());
  } catch {
    return null;
  }
}

/**
 * Next-route body. Unsigned → 401. Bad kind/subject → 400.
 * Missing env / hop fail → 503. Plane 200 (including `ok: false`) → 200.
 * Never returns the product API key. Do not invent a grant from a miss.
 */
export async function sessionGatedAttest(input: {
  sessionAddress: string | null;
  body?: unknown;
  env?: EnvLike;
  fetchImpl?: typeof fetch;
}): Promise<AttestRouteResult> {
  if (!input.sessionAddress) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const request = parseAttestRequest(input.body);
  if (!request) {
    return { status: 400, body: { error: "invalid-subject" } };
  }
  const cfg = readOraclesAttestEnv(input.env);
  if (!cfg) {
    return { status: 503, body: { error: "oracles-unconfigured" } };
  }
  const observed = await hopPanopticonAttest({
    cfg,
    request,
    fetchImpl: input.fetchImpl,
  });
  if (!observed) {
    return { status: 503, body: { error: "oracles-unavailable" } };
  }
  return { status: 200, body: observed };
}
