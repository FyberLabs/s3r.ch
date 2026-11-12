/** Listing metadata only. No field in this model authorizes execution. */
export type ToolListing = Readonly<{
  id: string; name: string; description: string; kind: "web" | "local" | "web-and-local" | "unknown";
  source: "visor" | "mcp-registry"; sourceLabel: string; version: string | null;
  nameStatus: "unverified" | "registry-verified"; reportedState: string;
  tools: readonly Readonly<{ name: string; title: string; description: string }>[];
  authorization: "not-requested"; safetyReview: "not-requested";
}>;
export const DISCOVERY_BYTES_MAX = 512 * 1024;
export function registryName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
export function registryText(value: unknown, maximum: number, optional = false): string {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Error("Invalid tool listing");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid tool listing");
  return value as Record<string, unknown>;
}
/** Consume Visor GET /session/{id}/mcp output; never initiate MCP discovery. */
export function visorToolListings(raw: string, sourceLabel: string): readonly ToolListing[] {
  registryText(sourceLabel, 100);
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > DISCOVERY_BYTES_MAX) throw Error("Tool list is too large");
  const snapshot = object(JSON.parse(raw)), profile = registryText(snapshot.profile, 128);
  if (!Array.isArray(snapshot.servers) || snapshot.servers.length > 128) throw Error("Invalid tool list");
  const seen = new Set<string>(); let count = 0;
  return Object.freeze(snapshot.servers.map(value => {
    const server = object(value), name = registryText(server.name, 128), transport = registryText(server.transport, 40);
    if (seen.has(name) || !Array.isArray(server.tools) || server.tools.length > 256) throw Error("Invalid tool list");
    seen.add(name); count += server.tools.length;
    if (count > 2048) throw Error("Tool list is too large");
    const names = new Set<string>();
    const tools = Object.freeze(server.tools.map(value => {
      const tool = object(value), name = registryText(tool.name, 128);
      if (names.has(name)) throw Error("Duplicate tool name");
      names.add(name);
      return Object.freeze({ name, title: registryText(tool.title, 256, true) || name,
        description: registryText(tool.description, 4096, true) });
    }));
    const state = registryText(server.routing_status, 64, true) || "unknown";
    return Object.freeze({ id: JSON.stringify(["visor", sourceLabel, profile, name]), name, description: "", source: "visor" as const,
      sourceLabel: sourceLabel + " / " + profile, version: null, nameStatus: "unverified" as const,
      kind: transport === "stdio" ? "local" as const : ["http", "sse"].includes(transport) ? "web" as const : "unknown" as const,
      reportedState: state, tools, authorization: "not-requested" as const, safetyReview: "not-requested" as const });
  }));
}
