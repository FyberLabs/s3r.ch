import { parseTerminalOwnerConfig, terminalOwnerConfigName } from "./terminal-owner-config";
import type { RunToken } from "./terminal-run";
type Snapshot = { raw: string | undefined; config: ReturnType<typeof parseTerminalOwnerConfig> | null };
const key = Symbol.for("s3rch.terminal.config.v1");
const shared = globalThis as typeof globalThis & { [key]?: Snapshot };
/** Immutable per-process configuration. A malformed or changed setting never falls back. */
export function terminalRuntimeConfig() {
  const raw = process.env[terminalOwnerConfigName];
  if (shared[key]) {
    if (shared[key].raw !== raw) throw Error("Terminal configuration changed");
    return shared[key];
  }
  const config = raw === undefined ? null : parseTerminalOwnerConfig(raw);
  return shared[key] = Object.freeze({ raw, config });
}
export function requireConfiguredAdmission(token: RunToken, admitted: boolean) {
  const { config } = terminalRuntimeConfig();
  if (!config || admitted || token.subject === null) return;
  if (Object.values(config.scopes).some(scope => scope.subject === token.subject || scope.identities.sea.includes(token.subject!)))
    throw Error("Terminal run authority unavailable");
}
