import { createHmac, timingSafeEqual } from "node:crypto";
import { matchesRequestOrigin } from "../request-origin";
import { uniqueJson } from "./forum-witness-json";
import { parseTerminalScope } from "./terminal-run-client";
import { parseTerminalOwnerConfig } from "./terminal-owner-config";
const hex = /^[a-f0-9]{64}$/;
const fail = (): never => { throw Error("nightly-run-refused"); };
function fields(value: unknown, names: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.split(" ").sort().join()) return fail();
  return value as Record<string, unknown>;
}
async function bytes(message: Request | Response, signal: AbortSignal) {
  if (message.headers.get("content-type")?.split(";")[0] !== "application/json" || message.headers.has("content-encoding") || !message.body) return fail();
  const reader = message.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.length; if (size > 16384) return fail(); chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Uninstalled owner endpoint. Auth's durable registry alone owns lifecycle state.
 * No local tombstones, retries, route registration or environment reads. */
export function createTerminalOwnerControl(rawConfig: string, fetcher: typeof fetch = fetch) {
  const config = parseTerminalOwnerConfig(rawConfig), origin = new URL(config.origin);
  const controllerKey = Buffer.from(config.controllerKey, "hex"), ownerKey = Buffer.from(config.ownerKey, "hex");
  return async (request: Request): Promise<Response> => {
    let response: Response | undefined;
    try {
      const url = new URL(request.url), signature = request.headers.get("X-Nightly-Controller-Signature");
      if (!matchesRequestOrigin(request, origin) || url.pathname !== "/api/internal/nightly-run" || url.search ||
          request.method !== "POST" || !signature || !hex.test(signature)) return fail();
      const signal = AbortSignal.any([AbortSignal.timeout(5000), request.signal]), raw = await bytes(request, signal);
      if (!timingSafeEqual(createHmac("sha256", controllerKey).update(raw).digest(), Buffer.from(signature, "hex"))) return fail();
      const decoded = uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      const action = decoded && typeof decoded === "object" && "action" in decoded ? decoded.action : null;
      if (typeof action !== "string" || !["register", "status", "seal", "retire"].includes(action)) return fail();
      const value = fields(decoded, "version owner action run generation fence" + (action === "register" ? " grant scope" : ""));
      if (value.version !== 1 || value.owner !== "s3rch" || typeof value.run !== "string" ||
          typeof value.generation !== "string" || !hex.test(value.generation) ||
          typeof value.fence !== "number" || !Number.isSafeInteger(value.fence) || value.fence <= 0) return fail();
      // Refuse integers that JavaScript cannot represent exactly; never round a fence.
      const suite = value.run.match(/^[0-9]{1,20}-[0-9]{1,20}-(flags-s3rch-browser|s3rch-device-transfer)$/)?.[1] as keyof typeof config.scopes | undefined;
      if (!suite) return fail();
      if (action === "register" && (typeof value.grant !== "string" || !hex.test(value.grant) ||
          JSON.stringify(parseTerminalScope(value.scope)) !== JSON.stringify(config.scopes[suite]))) return fail();
      response = await fetcher(config.authOrigin + "/auth/nightly-run/v1/command", {
        method: "POST", redirect: "error", cache: "no-store", credentials: "omit", signal,
        headers: { "Content-Type": "application/json", "X-Nightly-Owner-Signature": createHmac("sha256", ownerKey).update(raw).digest("hex") }, body: raw.toString("utf8"),
      });
      if (response.status !== 200 || response.redirected) return fail();
      const result = fields(uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, signal))),
        "version owner run generation phase terminal_verified");
      if (result.version !== 1 || result.owner !== "s3rch" || result.run !== value.run || result.generation !== value.generation ||
          typeof result.phase !== "string" || !["active", "sealed", "terminal"].includes(result.phase) || typeof result.terminal_verified !== "boolean" ||
          result.terminal_verified !== (result.phase === "terminal") ||
          action === "register" && result.phase !== "active" || action === "retire" && result.phase !== "terminal" ||
          action === "seal" && result.phase === "active") return fail();
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
      return Response.json({ error: "nightly-run-refused" }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  };
}
