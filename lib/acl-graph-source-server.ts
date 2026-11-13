import type { ForumRecoverySnapshot } from "./identity/forum-recovery-history";
export type ProtectedGraphSnapshot = Readonly<{ completeThrough: number; history: ForumRecoverySnapshot; rows: readonly unknown[]; audience?: string }>;

export class StatementSourceConflict extends Error {}
export type AclStatementConfig = Readonly<{ origin: string; tenant: string; apiKey: string; scope: string }>;
/** The API supplies a complete, protected owner snapshot. This adapter neither
 * manufactures completeness nor retries appends over a changed source. */
export function createAclGraphSource(input: AclStatementConfig, collection: "statements" | "delegations", fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now() / 1000)) {
  if (!["statements", "delegations"].includes(collection)) throw Error("Invalid graph collection");
  const config = Object.freeze({ ...input });
  if (Object.values(config).length !== 4 || [config.origin, config.tenant, config.scope, config.apiKey].some(value => typeof value !== "string"))
    throw Error("Invalid statement source configuration");
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" ||
      origin.port || origin.search || origin.hash || origin.origin !== config.origin ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(config.tenant) ||
      config.tenant === "00000000-0000-0000-0000-000000000000" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.scope) ||
      !/^[\x21-\x7e]{1,4096}$/.test(config.apiKey)) throw Error("Invalid statement source configuration");
  const base = origin.origin + "/api/v1/acl/sociacl/" + collection + "/" + config.scope + "/";
  const atNow = (at: number) => { if (!Number.isSafeInteger(at) || at < 0 || clock() !== at) throw new StatementSourceConflict(); };
  async function call(operation: "snapshot" | "append", body: unknown, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(1500)]);
    const bounded = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
      const abort = () => reject(Error("Statement source cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await bounded(fetcher(base + operation, { method: "POST", redirect: "error", cache: "no-store",
        credentials: "omit", signal, headers: { "X-Api-Key": config.apiKey, "X-Tenant-ID": config.tenant,
          "Content-Type": "application/json", "Accept-Encoding": "identity" }, body: JSON.stringify(body) }).then(value => {
          if (signal.aborted) { void value.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
          return value;
        }));
      signal.throwIfAborted();
      if (!response) throw Error("Missing statement source response");
      if (response.status === 409) throw new StatementSourceConflict();
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) throw Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted(); const chunk = await bounded(reader.read()); signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > (operation === "snapshot" ? 4 * 1024 * 1024 + 4096 : 64)) throw Error();
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
      signal.throwIfAborted();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof StatementSourceConflict) throw error;
      throw Error("Trusted statement source unavailable");
    } finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
  }
  return Object.freeze({
    async read(at: number, signal: AbortSignal) {
      atNow(at);
      const result = await call("snapshot", { evaluatedAt: at }, signal);
      atNow(at); signal.throwIfAborted();
      if (!result || Object.keys(result).sort().join() !== "fence,snapshot" || typeof result.fence !== "string" || !/^[a-f0-9]{64}$/.test(result.fence) ||
          !result.snapshot || Object.keys(result.snapshot).sort().join() !== (collection === "statements" ? "completeThrough,history,rows" : "audience,completeThrough,history,rows") ||
          result.snapshot.completeThrough !== at || result.snapshot.history?.completeThrough !== at ||
          !Array.isArray(result.snapshot.rows) || result.snapshot.rows.length > 1024 ||
          !Array.isArray(result.snapshot.history.accounts) || result.snapshot.history.accounts.length > 64 ||
          !Array.isArray(result.snapshot.history.links)) throw Error("Invalid statement snapshot");
      return { snapshot: structuredClone(result.snapshot) as ProtectedGraphSnapshot, fence: `${at}.${result.fence}` };
    },
    async append(fence: string, rows: readonly unknown[], guard: () => void, signal: AbortSignal) {
      if (typeof fence !== "string") throw Error("Invalid statement fence");
      const match = /^(0|[1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(fence);
      if (!match) throw Error("Invalid statement fence");
      const at = Number(match[1]); atNow(at); signal.throwIfAborted(); guard();
      const saved = structuredClone(rows);
      if (!Array.isArray(saved) || saved.length < 1 || saved.length > 65 || Buffer.byteLength(JSON.stringify(saved)) > 65536)
        throw Error("Invalid statement append");
      try {
        const response = await call("append", { evaluatedAt: at, fence: match[2], rows: saved }, signal);
        atNow(at); signal.throwIfAborted(); guard();
        if (!response || Object.keys(response).join() !== "ok" || response.ok !== true) throw Error("Invalid statement append response");
        return true;
      } catch (error) { if (error instanceof StatementSourceConflict) return false; throw error; }
    },
  });
}

