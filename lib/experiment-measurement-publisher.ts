import { open, constants } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type MeasurementRow = Readonly<{ ActionId: string; Experiment: string; Variant: string;
  Metric: "error_rate" | "latency_ms" | "dependency_failure_rate" | "session_failure_rate"; ObservedAt: number; Value: number }>;

export async function privateMeasurementSecret(path: string) {
  if (!isAbsolute(path)) throw Error("Private measurement credential required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size < 16 || stat.size > 4096)
      throw Error("Private measurement credential required");
    const bytes = Buffer.alloc(4097), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, bytesRead).toString("utf8").trim();
    if (bytesRead > 4096 || !/^[\x21-\x7e]{16,4096}$/.test(value)) throw Error("Private measurement credential required");
    return value;
  } finally { await file.close(); }
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw Error("Measurement authentication unavailable");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 32768) throw Error("Measurement authentication unavailable"); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** A separate server DCR credential; never called by browser analytics or outbox sinks. */
export function createMeasurementPublisher(input: {
  endpoint: string; rule: string; directory: string; clientId: string; secret: string;
}, transport: typeof fetch = fetch) {
  const endpoint = new URL(input.endpoint);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".ingest.monitor.azure.com") || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
      !/^dcr-[a-f0-9]{32}$/.test(input.rule) || !uuid.test(input.directory) || !uuid.test(input.clientId) ||
      [input.directory, input.clientId].includes("00000000-0000-0000-0000-000000000000") || !/^[\x21-\x7e]{16,4096}$/.test(input.secret))
    throw Error("Invalid measurement publisher binding");
  const url = `${endpoint.origin}/dataCollectionRules/${input.rule}/streams/Custom-ExperimentGuardrail?api-version=2023-01-01`;
  const queue: MeasurementRow[][] = []; let running = false, stopped = false;
  let active: AbortController | undefined;
  let token: { value: string; until: number } | undefined;
  async function deliver(rows: MeasurementRow[]) {
    const controller = new AbortController(); active = controller;
    const signal = controller.signal;
    AbortSignal.timeout(3000).addEventListener("abort", () => controller.abort(), { once: true });
    if (!token || Date.now() >= token.until) {
      const response = await transport(`https://login.microsoftonline.com/${input.directory}/oauth2/v2.0/token`, {
        method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: input.clientId,
          client_secret: input.secret, scope: "https://monitor.azure.com/.default" }),
      });
      try {
        if (response.status !== 200) throw Error("Measurement authentication unavailable");
        const body = await boundedJson(response);
        if (typeof body.access_token !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(body.access_token) || body.token_type !== "Bearer" ||
            !Number.isSafeInteger(body.expires_in) || body.expires_in < 60 || body.expires_in > 86400) throw Error("Measurement authentication unavailable");
        token = { value: body.access_token, until: Date.now() + Math.min(body.expires_in - 30, 300) * 1000 };
      } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    }
    const response = await transport(url, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" }, body: JSON.stringify(rows) });
    try { if (response.status !== 204) throw Error("Measurement ingestion unavailable"); }
    finally { await response.body?.cancel().catch(() => {}); }
  }
  async function drain() {
    if (running) return; running = true;
    try { while (queue.length && !stopped) {
      const rows = queue.shift()!;
      if (rows.some(row => row.ObservedAt < Math.floor(Date.now() / 1000) - 60)) continue;
      try { await deliver(rows); } catch { /* Missing observations cannot disable experiments. */ }
    } } finally { running = false; }
  }
  return Object.freeze({
    publish(rows: readonly MeasurementRow[]): boolean {
      if (stopped || queue.length >= 64 || rows.length !== 3) return false;
      const now = Math.floor(Date.now() / 1000), label = /^[a-z][a-z0-9_-]{0,63}$/;
      if (rows.some(row => Object.keys(row).sort().join() !== "ActionId,Experiment,Metric,ObservedAt,Value,Variant" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.ActionId) ||
          !label.test(row.Experiment) || !label.test(row.Variant) || !["error_rate", "latency_ms", "dependency_failure_rate", "session_failure_rate"].includes(row.Metric) ||
          !Number.isSafeInteger(row.ObservedAt) || row.ObservedAt < now - 60 || row.ObservedAt > now || !Number.isFinite(row.Value) || row.Value < 0 ||
          row.Metric !== "latency_ms" && row.Value !== 0 && row.Value !== 1)) return false;
      if (new Set(rows.map(row => row.Metric)).size !== 3 || rows.some(row => row.ActionId !== rows[0].ActionId || row.Experiment !== rows[0].Experiment || row.Variant !== rows[0].Variant || row.ObservedAt !== rows[0].ObservedAt)) return false;
      queue.push(rows.map(row => ({ ...row }))); void drain(); return true;
    },
    close() { stopped = true; queue.length = 0; token = undefined; active?.abort(); },
  });
}
