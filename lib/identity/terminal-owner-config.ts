import { uniqueJson } from "./forum-witness-json";
import { parseTerminalScope } from "./terminal-run-client";

/** Deployment contract only. No environment read, route installation or grant registration. */
export const terminalOwnerConfigName = "S3RCH_NIGHTLY_RUN_CONFIG";
const refused = (): never => { throw Error("Terminal owner configuration unavailable"); };
const suites = ["flags-s3rch-browser", "s3rch-device-transfer"] as const;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return refused();
  return value as Record<string, unknown>;
}
/** Decode the private per-owner JSON prepared by Infra's deployment lease owner.
 * Both suites must be explicit. Configuration alone is never readiness evidence.
 */
export function parseTerminalOwnerConfig(raw: string) {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 16384) return refused();
    const value = exact(uniqueJson(raw), ["version", "owner", "origin", "authOrigin", "controllerKey", "ownerKey", "scopes"]);
    if (value.version !== 1 || value.owner !== "s3rch" || value.origin !== "https://test.s3r.ch" ||
        value.authOrigin !== "https://api.test.hyperme.sh" ||
        typeof value.controllerKey !== "string" || !/^[a-f0-9]{64}$/.test(value.controllerKey) ||
        typeof value.ownerKey !== "string" || !/^[a-f0-9]{64}$/.test(value.ownerKey) || value.controllerKey === value.ownerKey) return refused();
    const declared = exact(value.scopes, suites);
    const parsed = suites.map(suite => {
      const scope = parseTerminalScope(declared[suite]);
      if (scope.suite !== suite || scope.origins.length !== 1 || scope.origins[0] !== value.origin ||
          (suite === "s3rch-device-transfer" && scope.identities.sea.length === 0)) return refused();
      return scope;
    });
    return Object.freeze({ version: 1 as const, owner: "s3rch" as const, origin: "https://test.s3r.ch" as const,
      authOrigin: "https://api.test.hyperme.sh" as const, controllerKey: value.controllerKey, ownerKey: value.ownerKey,
      scopes: Object.freeze({ "flags-s3rch-browser": parsed[0], "s3rch-device-transfer": parsed[1] }) });
  } catch { return refused(); }
}
