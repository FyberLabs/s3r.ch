import type { ForumAuthorityReader } from "./forum-authority-source";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import { squadView, type LiveSquadSpec } from "./squad-view";

const MAX_BYTES = 4 * 1024 * 1024;
/** Response from the provisioned same-origin complete-history service. The
 * service authenticates the session and derives scope independently; request
 * fields are scope assertions, never authority. This envelope is not accepted
 * from Gun, and its completeness still depends on that trusted service. */
export type ForumAuthorityResponse = Readonly<{
  version: 1; forumId: string; owner: string; evaluatedAt: number;
  snapshot: ForumAuthoritySnapshot;
}>;

/** No endpoint is defaulted. Only an absolute-path same-origin endpoint may be
 * supplied by deployment wiring. Redirects (including login HTML) fail closed.
 * Signature/history verification remains createForumAuthority's responsibility.
 */
export function createHttpForumAuthorityReader(input: {
  endpoint: string; squad: LiveSquadSpec; fetch?: typeof fetch;
}): ForumAuthorityReader {
  const view = squadView(input.squad);
  if (!view.live) throw Error("Live Squad required");
  const endpoint = input.endpoint;
  if (typeof endpoint !== "string" || !/^\/[A-Za-z0-9/_-]+$/.test(endpoint) || endpoint.startsWith("//"))
    throw Error("Same-origin authority endpoint required");
  const fetcher = input.fetch ?? fetch;
  return async (at, signal) => {
    if (!Number.isSafeInteger(at) || at < 0 || Object.is(at, -0)) return null;
    signal.throwIfAborted();
    const response = await fetcher(endpoint, {
      method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ version: 1, forumId: view.forumId, owner: view.owner, evaluatedAt: at }),
    });
    if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      await response.body?.cancel(); return null;
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      await response.body?.cancel(); return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ForumAuthorityResponse;
      if (!envelope || Object.keys(envelope).sort().join() !== "evaluatedAt,forumId,owner,snapshot,version" ||
          envelope.version !== 1 || envelope.forumId !== view.forumId || envelope.owner !== view.owner || envelope.evaluatedAt !== at) return null;
      const snapshot = envelope.snapshot;
      if (!snapshot || !Number.isSafeInteger(snapshot.completeThrough) || snapshot.completeThrough < at ||
          !snapshot.history || !Number.isSafeInteger(snapshot.history.completeThrough) || snapshot.history.completeThrough < at ||
          !Array.isArray(snapshot.rows) || snapshot.rows.length > 1024) return null;
      return snapshot;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
}
