import { registryName, registryText, type ToolListing } from "./tool-registry";
const ROOT = "https://registry.modelcontextprotocol.io/v0.1/servers/";
const LIMIT = 256 * 1024;
/** Only this fixed official registry transport can label a registry name verified.
 * This verifies the catalog namespace, never a connected instance or its code. */
export function createToolRegistryLookup(fetcher: typeof fetch = fetch) {
  let active = 0;
  return async function lookup(name: string): Promise<ToolListing | null> {
    if (!registryName(name)) throw Error("Invalid registry name");
    if (active >= 4) throw Error("Registry busy");
    active++;
    let response: Response | undefined;
    try {
      const signal = AbortSignal.timeout(8000);
      response = await fetcher(ROOT + encodeURIComponent(name) + "/versions/latest", {
        redirect: "error", credentials: "omit", cache: "no-store", signal,
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      });
      if (response.status === 404) return null;
      if (response.status !== 200 || !response.body || ![null, "identity"].includes(response.headers.get("content-encoding"))) throw Error();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^[1-9][0-9]{0,6}$/.test(length) || Number(length) > LIMIT)) throw Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > LIMIT) throw Error();
          chunks.push(new Uint8Array(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      signal.throwIfAborted();
      if (length !== null && size !== Number(length)) throw Error();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), server = value?.server;
      if (!server || server.name !== name || value?._meta?.["io.modelcontextprotocol.registry/official"]?.status !== "active") throw Error();
      const version = registryText(server.version, 128), description = registryText(server.description, 4096, true);
      const web = Array.isArray(server.remotes) && server.remotes.length > 0, local = Array.isArray(server.packages) && server.packages.length > 0;
      return Object.freeze({ id: JSON.stringify(["mcp-registry", name, version]), name, description,
        source: "mcp-registry", sourceLabel: "Official MCP Registry", version,
        kind: web && local ? "web-and-local" : web ? "web" : local ? "local" : "unknown",
        nameStatus: "registry-verified", reportedState: "catalog-only", tools: Object.freeze([]),
        authorization: "not-requested", safetyReview: "not-requested" });
    } catch { throw Error("Registry lookup unavailable"); }
    finally { active--; if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  };
}
const lookup = createToolRegistryLookup();
export async function toolRegistryResponse(request: Request, read = lookup) {
  const query = new URL(request.url).searchParams, name = query.get("name");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (query.size !== 1 || !registryName(name)) return Response.json({ error: "Enter a registry name such as com.example/tool." }, { status: 400, headers });
  try {
    const listing = await read(name);
    return Response.json(listing ? { listing } : { error: "Registry name not found." }, { status: listing ? 200 : 404, headers });
  } catch { return Response.json({ error: "Registry lookup is unavailable. Try again later." }, { status: 503, headers }); }
}
