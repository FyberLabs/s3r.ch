/**
 * Server hop: s3r.ch SIWE session → Panopticon payments access v0.
 *
 * Contract: FyberLabs/panopticon `products/payments/docs/payments-access-v0.md`.
 * `POST /api/v1/payments/v0/receipt` (required plane hop) → `{ ok, status, accessUntil? }`.
 * `POST /api/v1/payments/v0/intent` (optional) → `{ ok, status, intentId, payTo, … }`.
 *
 * Env (server-only, empty = no hop):
 *   PANOPTICON_PAYMENTS_BASE  origin or origin+/api/v1[/payments[/v0]]
 *   PANOPTICON_TENANT_ID      marketplace tenant UUID (`X-Tenant-ID`)
 *   PANOPTICON_API_KEY        product API key (`X-Api-Key`). Never NEXT_PUBLIC_*.
 *
 * Never Gun. Never localStorage. Never Stripe / core/payment-service.
 * Never SIWE-as-Panopticon-login. Never Keycloak as s3r.ch login.
 * Fail soft: missing env / 401 / 503 / network / bad JSON → caller keeps
 * the public page. Do not invent a SociACL grant. Do not hard-paywall.
 */

export const PANOPTICON_PAYMENTS_PREFIX = "/api/v1/payments/v0";
export const PANOPTICON_RECEIPT_PATH = "/api/v1/payments/v0/receipt";
export const PANOPTICON_INTENT_PATH = "/api/v1/payments/v0/intent";
export const DEFAULT_CLIENT_HINT = "s3rch-next";
export const PAYMENTS_FETCH_MS = 8_000;
export const PAYMENTS_USER_AGENT = "s3r.ch-payments-access/0.1 (Fyber Labs)";
export const PAYMENTS_ASSET = "USDC";

export const ENV_PAYMENTS_BASE = "PANOPTICON_PAYMENTS_BASE";
export const ENV_TENANT_ID = "PANOPTICON_TENANT_ID";
export const ENV_API_KEY = "PANOPTICON_API_KEY";

const IDENTIFIER_MAX = 256;
const INTENT_ID_MAX = 128;
const CLIENT_HINT_MAX = 128;
const AMOUNT_MAX = 32;
const IDENTIFIER_CHARS = /^[A-Za-z0-9:._/-]+$/;
const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export type EnvLike = Record<string, string | undefined>;

export type PaymentsAccessEnv = {
  base: string;
  tenantId: string;
  apiKey: string;
};

export type PaymentsAsset = "USDC";
export type IntentStatus = "quoted" | "unavailable" | "error";
export type ReceiptStatus = "verified" | "not_found" | "unverified" | "expired" | "error";

export type IntentOk = {
  ok: boolean;
  status: IntentStatus;
  intentId: string | null;
  resource: string;
  asset: PaymentsAsset;
  amount: string | null;
  payTo: string | null;
  memo: string | null;
  expiresAt: string | null;
  upstream: string;
};

export type ReceiptOk = {
  ok: boolean;
  status: ReceiptStatus;
  resource: string;
  accessUntil: string | null;
  upstream: string;
};

export type PaymentsErrorBody = { error: string };

export type IntentRouteResult =
  | { status: 200; body: IntentOk }
  | { status: 400; body: PaymentsErrorBody }
  | { status: 401; body: PaymentsErrorBody }
  | { status: 503; body: PaymentsErrorBody };

export type ReceiptRouteResult =
  | { status: 200; body: ReceiptOk }
  | { status: 400; body: PaymentsErrorBody }
  | { status: 401; body: PaymentsErrorBody }
  | { status: 503; body: PaymentsErrorBody };

export type IntentHopInput = {
  resource: string;
  asset: PaymentsAsset;
  amount?: string;
  clientHint: string;
};

export type ReceiptHopInput = {
  resource: string;
  txRef: string;
  intentId?: string;
  asset: PaymentsAsset;
  amount?: string;
  clientHint: string;
};

export function trimEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * All three must be non-empty. Base must be http(s). Localhost is allowed
 * so a lab Panopticon on :8014 works. Empty / invalid = not configured.
 */
export function readPaymentsAccessEnv(
  env: EnvLike = process.env,
): PaymentsAccessEnv | null {
  const tenantId = trimEnv(env[ENV_TENANT_ID]);
  const apiKey = trimEnv(env[ENV_API_KEY]);
  const rawBase = trimEnv(env[ENV_PAYMENTS_BASE]);
  if (!tenantId || !apiKey || !rawBase) return null;
  const base = normalizePaymentsBase(rawBase);
  if (!base) return null;
  return { base, tenantId, apiKey };
}

export function normalizePaymentsBase(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Join operator base to the locked receipt or intent path. */
export function panopticonPaymentsUrl(
  base: string,
  verb: "receipt" | "intent",
): string {
  const trimmed = base.replace(/\/+$/, "");
  const path = verb === "receipt" ? PANOPTICON_RECEIPT_PATH : PANOPTICON_INTENT_PATH;
  if (trimmed.endsWith(path)) return trimmed;
  if (trimmed.endsWith(PANOPTICON_PAYMENTS_PREFIX)) return `${trimmed}/${verb}`;
  if (trimmed.endsWith("/api/v1/payments")) return `${trimmed}/v0/${verb}`;
  if (trimmed.endsWith("/api/v1")) return `${trimmed}/payments/v0/${verb}`;
  return `${trimmed}${path}`;
}

export function paymentsHopHeaders(cfg: PaymentsAccessEnv): Record<string, string> {
  return {
    "X-Tenant-ID": cfg.tenantId,
    "X-Api-Key": cfg.apiKey,
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": PAYMENTS_USER_AGENT,
  };
}

/** Integrator label. Length-only in v0 (contract). Not persisted. Not Gun. */
export function sanitizeClientHint(raw: string | undefined): string {
  const cleaned = (raw ?? "").trim().slice(0, CLIENT_HINT_MAX);
  return cleaned || DEFAULT_CLIENT_HINT;
}

export function sanitizeIdentifier(
  raw: unknown,
  field: "resource" | "txRef",
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > IDENTIFIER_MAX) return null;
  if (value.includes("://") || /\s/.test(value)) return null;
  if (!IDENTIFIER_CHARS.test(value)) return null;
  return value;
}

export function sanitizeIntentId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > INTENT_ID_MAX) return null;
  if (value.includes("://") || /\s/.test(value)) return null;
  return value;
}

export function sanitizeAmount(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > AMOUNT_MAX || !AMOUNT_RE.test(value)) return null;
  if (!(Number(value) > 0)) return null;
  return value;
}

export function sanitizeAsset(raw: unknown): PaymentsAsset | null {
  if (raw === undefined || raw === null || raw === "") return PAYMENTS_ASSET;
  return raw === PAYMENTS_ASSET ? PAYMENTS_ASSET : null;
}

export function parseIntentBody(body: unknown): IntentHopInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "invalid-body" };
  const row = body as Record<string, unknown>;
  const resource = sanitizeIdentifier(row.resource, "resource");
  if (!resource) return { error: "invalid-resource" };
  const asset = sanitizeAsset(row.asset);
  if (!asset) return { error: "invalid-asset" };
  const amount = sanitizeAmount(row.amount);
  if (amount === null) return { error: "invalid-amount" };
  const parsed: IntentHopInput = {
    resource,
    asset,
    clientHint: DEFAULT_CLIENT_HINT,
  };
  if (amount !== undefined) parsed.amount = amount;
  return parsed;
}

export function parseReceiptBody(body: unknown): ReceiptHopInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "invalid-body" };
  const row = body as Record<string, unknown>;
  const resource = sanitizeIdentifier(row.resource, "resource");
  if (!resource) return { error: "invalid-resource" };
  const txRef = sanitizeIdentifier(row.txRef, "txRef");
  if (!txRef) return { error: "invalid-tx-ref" };
  const asset = sanitizeAsset(row.asset);
  if (!asset) return { error: "invalid-asset" };
  const amount = sanitizeAmount(row.amount);
  if (amount === null) return { error: "invalid-amount" };
  if (row.intentId !== undefined && row.intentId !== null && row.intentId !== "") {
    const intentId = sanitizeIntentId(row.intentId);
    if (!intentId) return { error: "invalid-intent-id" };
    const parsed: ReceiptHopInput = {
      resource,
      txRef,
      intentId,
      asset,
      clientHint: DEFAULT_CLIENT_HINT,
    };
    if (amount !== undefined) parsed.amount = amount;
    return parsed;
  }
  const parsed: ReceiptHopInput = {
    resource,
    txRef,
    asset,
    clientHint: DEFAULT_CLIENT_HINT,
  };
  if (amount !== undefined) parsed.amount = amount;
  return parsed;
}

export function intentRequestBody(input: IntentHopInput): Record<string, string> {
  const body: Record<string, string> = {
    resource: input.resource,
    asset: input.asset,
    clientHint: sanitizeClientHint(input.clientHint),
  };
  if (input.amount) body.amount = input.amount;
  return body;
}

export function receiptRequestBody(input: ReceiptHopInput): Record<string, string> {
  const body: Record<string, string> = {
    resource: input.resource,
    txRef: input.txRef,
    asset: input.asset,
    clientHint: sanitizeClientHint(input.clientHint),
  };
  if (input.intentId) body.intentId = input.intentId;
  if (input.amount) body.amount = input.amount;
  return body;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function optionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function parseIntentResponse(body: unknown): IntentOk | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (typeof row.ok !== "boolean") return null;
  if (
    row.status !== "quoted" &&
    row.status !== "unavailable" &&
    row.status !== "error"
  ) {
    return null;
  }
  if (row.ok !== (row.status === "quoted")) return null;
  if (typeof row.resource !== "string" || !row.resource) return null;
  if (row.asset !== PAYMENTS_ASSET) return null;
  if (typeof row.upstream !== "string" || !row.upstream) return null;
  const intentId = optionalString(row.intentId);
  const payTo = optionalString(row.payTo);
  const memo = optionalString(row.memo);
  const expiresAt = optionalTimestamp(row.expiresAt);
  const amount = optionalString(row.amount);
  if (row.ok) {
    if (!intentId || !payTo || !expiresAt) return null;
  }
  return {
    ok: row.ok,
    status: row.status,
    intentId: row.ok ? intentId : null,
    resource: row.resource,
    asset: PAYMENTS_ASSET,
    amount: amount,
    payTo: row.ok ? payTo : null,
    memo: row.ok ? memo : null,
    expiresAt: row.ok ? expiresAt : null,
    upstream: row.upstream,
  };
}

export function parseReceiptResponse(body: unknown): ReceiptOk | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (typeof row.ok !== "boolean") return null;
  if (
    row.status !== "verified" &&
    row.status !== "not_found" &&
    row.status !== "unverified" &&
    row.status !== "expired" &&
    row.status !== "error"
  ) {
    return null;
  }
  if (row.ok !== (row.status === "verified")) return null;
  if (typeof row.resource !== "string" || !row.resource) return null;
  if (typeof row.upstream !== "string" || !row.upstream) return null;
  const accessUntil = optionalTimestamp(row.accessUntil);
  if (row.ok && !accessUntil) return null;
  return {
    ok: row.ok,
    status: row.status,
    resource: row.resource,
    accessUntil: row.ok ? accessUntil : null,
    upstream: row.upstream,
  };
}

async function hopPayments<T>(input: {
  cfg: PaymentsAccessEnv;
  verb: "receipt" | "intent";
  body: Record<string, string>;
  parse: (body: unknown) => T | null;
  fetchImpl?: typeof fetch;
}): Promise<T | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = panopticonPaymentsUrl(input.cfg.base, input.verb);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: paymentsHopHeaders(input.cfg),
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(PAYMENTS_FETCH_MS),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return null;
    return input.parse(await response.json());
  } catch {
    return null;
  }
}

export async function hopPanopticonIntent(input: {
  cfg: PaymentsAccessEnv;
  body: IntentHopInput;
  fetchImpl?: typeof fetch;
}): Promise<IntentOk | null> {
  return hopPayments({
    cfg: input.cfg,
    verb: "intent",
    body: intentRequestBody(input.body),
    parse: parseIntentResponse,
    fetchImpl: input.fetchImpl,
  });
}

export async function hopPanopticonReceipt(input: {
  cfg: PaymentsAccessEnv;
  body: ReceiptHopInput;
  fetchImpl?: typeof fetch;
}): Promise<ReceiptOk | null> {
  return hopPayments({
    cfg: input.cfg,
    verb: "receipt",
    body: receiptRequestBody(input.body),
    parse: parseReceiptResponse,
    fetchImpl: input.fetchImpl,
  });
}

/**
 * Next-route body. Unsigned → 401. Bad identifiers → 400.
 * Missing env / hop fail → 503. Plane HTTP 200 (ok true or false) is 200.
 * Never returns the product API key. Never mints a SociACL grant.
 */
export async function sessionGatedIntent(input: {
  sessionAddress: string | null;
  body: unknown;
  env?: EnvLike;
  fetchImpl?: typeof fetch;
}): Promise<IntentRouteResult> {
  if (!input.sessionAddress) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const parsed = parseIntentBody(input.body);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const cfg = readPaymentsAccessEnv(input.env);
  if (!cfg) {
    return { status: 503, body: { error: "payments-unconfigured" } };
  }
  parsed.clientHint = sanitizeClientHint(input.sessionAddress);
  const quoted = await hopPanopticonIntent({
    cfg,
    body: parsed,
    fetchImpl: input.fetchImpl,
  });
  if (!quoted) {
    return { status: 503, body: { error: "payments-unavailable" } };
  }
  return { status: 200, body: quoted };
}

export async function sessionGatedReceipt(input: {
  sessionAddress: string | null;
  body: unknown;
  env?: EnvLike;
  fetchImpl?: typeof fetch;
}): Promise<ReceiptRouteResult> {
  if (!input.sessionAddress) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const parsed = parseReceiptBody(input.body);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const cfg = readPaymentsAccessEnv(input.env);
  if (!cfg) {
    return { status: 503, body: { error: "payments-unconfigured" } };
  }
  parsed.clientHint = sanitizeClientHint(input.sessionAddress);
  const receipt = await hopPanopticonReceipt({
    cfg,
    body: parsed,
    fetchImpl: input.fetchImpl,
  });
  if (!receipt) {
    return { status: 503, body: { error: "payments-unavailable" } };
  }
  return { status: 200, body: receipt };
}
