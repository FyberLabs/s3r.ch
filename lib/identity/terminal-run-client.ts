import { createHmac } from "node:crypto";
import { uniqueJson } from "./forum-witness-json";
import { isSeaPubkey } from "./forum-check";
import { isPublicSquadPrincipal } from "../squad-view";
import type { RunAdmission, RunToken, TerminalRunAuthority } from "./terminal-run";

const refused = (): never => { throw Error("Terminal run authority unavailable"); };
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const suites = ["flags-s3rch-browser", "s3rch-device-transfer"];
function row(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(" ").sort().join()) return refused();
  return value as Record<string, unknown>;
}
function list(value: unknown, accept: (value: string) => boolean, empty = false): readonly string[] {
  if (!Array.isArray(value) || value.length > 8 || (!empty && !value.length) ||
      !value.every((item, i) => typeof item === "string" && accept(item) && (!i || value[i - 1] < item))) return refused();
  return Object.freeze([...value]);
}
export function parseTerminalScope(value: unknown) {
  const scope = row(value, "suite subject tenant organization realm issuer clients origins identities");
  if (typeof scope.suite !== "string" || !suites.includes(scope.suite) || scope.realm !== "controlplane" ||
      scope.issuer !== "https://auth.test.hyperme.sh/realms/controlplane" ||
      typeof scope.subject !== "string" || !uuid.test(scope.subject) || typeof scope.tenant !== "string" || !uuid.test(scope.tenant) ||
      typeof scope.organization !== "string" || (scope.organization !== "" && !uuid.test(scope.organization))) return refused();
  const identities = row(scope.identities, "sea");
  const origins = list(scope.origins, value => ["https://portal.test.hyperme.sh", "https://test.s3r.ch", "https://test.hyperme.sh", "https://auth.test.hyperme.sh"].includes(value));
  if (!origins.some(value => value === "https://test.s3r.ch")) return refused();
  return Object.freeze({ suite: scope.suite, subject: scope.subject, tenant: scope.tenant, organization: scope.organization,
    realm: scope.realm, issuer: scope.issuer, clients: list(scope.clients, value => /^[A-Za-z0-9_-]{1,128}$/.test(value)), origins,
    identities: Object.freeze({ sea: list(identities.sea, value => isSeaPubkey(value) && !isPublicSquadPrincipal(value), true) }) });
}
/** One instance per admitted request. Configuration is deployment-owned; the
 * browser supplies only a grant, never scope, native identities or service keys.
 * This adapter is uninstalled until the complete route inventory is guarded.
 */
export function createTerminalHttpAuthority(config: { serviceKey: string; scopes: readonly unknown[] }, fetcher: typeof fetch = fetch): TerminalRunAuthority {
  if (!hex.test(config.serviceKey) || !Array.isArray(config.scopes) || config.scopes.length < 1 || config.scopes.length > 2) return refused();
  const key = Buffer.from(config.serviceKey, "hex"), scopes = config.scopes.map(parseTerminalScope);
  if (new Set(scopes.map(scope => scope.suite)).size !== scopes.length) return refused();
  let used = false, admitted: RunAdmission | undefined, scope: ReturnType<typeof parseTerminalScope> | undefined;
  async function command(action: string, fields: Record<string, unknown>) {
    const body = JSON.stringify({ version: 1, owner: "s3rch", action, ...fields });
    const signal = AbortSignal.timeout(5000);
    let response: Response | undefined;
    try {
      response = await fetcher("https://api.test.hyperme.sh/auth/nightly-run/v1/command", { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", signal,
        headers: { "Content-Type": "application/json", "X-Nightly-Owner-Signature": createHmac("sha256", key).update(body).digest("hex") }, body });
      if (response.status !== 200 || response.redirected || response.headers.get("content-type")?.split(";")[0] !== "application/json" || response.headers.has("content-encoding") || !response.body) return refused();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
          size += part.value.length; if (size > 16384) return refused(); chunks.push(part.value); }
      } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { return refused(); }
    finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  function same(value: RunAdmission) {
    if (!admitted || value.operation !== admitted.operation || value.binding.run !== admitted.binding.run || value.binding.generation !== admitted.binding.generation) refused();
  }
  function receipt(value: unknown, admission: RunAdmission, extra: string) {
    const result = row(value, "version owner run generation " + extra);
    if (result.version !== 1 || result.owner !== "s3rch" || result.run !== admission.binding.run || result.generation !== admission.binding.generation) return refused();
    return result;
  }
  return Object.freeze({
    async admit(request: Request) {
      if (used || new URL(request.url).origin !== "https://test.s3r.ch") return refused();
      used = true;
      const cookies = request.headers.get("cookie") ?? "";
      if (cookies.length > 16384) return refused();
      const grants = cookies.split(";").map(value => value.trim()).filter(value => value.startsWith("__Host-nightly-run-grant="));
      const grant = grants[0]?.slice("__Host-nightly-run-grant=".length);
      if (grants.length !== 1 || !grant || !hex.test(grant)) return refused();
      const result = row(await command("admit", { grant }), "version owner run generation scope operation");
      if (result.version !== 1 || result.owner !== "s3rch" || typeof result.run !== "string" ||
          !/^[0-9]{1,20}-[0-9]{1,20}-(flags-s3rch-browser|s3rch-device-transfer)$/.test(result.run) ||
          typeof result.generation !== "string" || !hex.test(result.generation) || typeof result.operation !== "string" || !uuid.test(result.operation)) return refused();
      const candidate = parseTerminalScope(result.scope);
      if (!result.run.endsWith("-" + candidate.suite) || !scopes.some(expected => JSON.stringify(expected) === JSON.stringify(candidate))) return refused();
      scope = candidate;
      admitted = Object.freeze({ binding: Object.freeze({ run: result.run, generation: result.generation }), operation: result.operation });
      return admitted;
    },
    async active(admission: RunAdmission) {
      same(admission);
      return receipt(await command("verify", { ...admission.binding }), admission, "active").active === true;
    },
    async complete(admission: RunAdmission) {
      same(admission);
      const result = receipt(await command("complete", { ...admission.binding, operation: admission.operation }), admission, "operation completed");
      if (result.operation !== admission.operation || result.completed !== true) refused();
    },
    async authorizeToken(admission: RunAdmission, token: RunToken) {
      same(admission);
      if (!scope) return false;
      if (/^s3rch-(identity|linked|agent)-(challenge|session)-v1(?::[a-f0-9]{64})?$/.test(token.kind))
        return token.subject !== null && scope.identities.sea.includes(token.subject);
      if (["provider-id-token", "s3rch-device-person-v1", "s3rch-startup-credential-v1"].includes(token.kind)) return token.subject === scope.subject;
      if (["s3rch-device-pkce-v1", "s3rch-startup-pkce-v1", "s3rch-experiment-consent-v1", "s3rch-experiment-display-v1"].includes(token.kind)) return token.subject === null;
      // Wallet labels and unsupported alternate credentials cannot bypass SEA policy.
      return false;
    },
  });
}
