import type { SeaPair } from "./identity/sea";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { isForumObjectId, sameEmbeddedPrincipal } from "./identity/forum-check";
import type { ForumAuthorityReader } from "./forum-authority-source";
import type { LiveSquadSpec } from "./squad-view";

export type StatementAdmissionRequest = Readonly<{ id: string; author: string; ts: number }>;
export type StatementAdmission = (item: StatementAdmissionRequest) => Promise<{ snapshot: ForumAuthoritySnapshot; at: number }>;
/** Sign only a new statement belonging to this session's current principal.
 * The protected endpoint independently admits its ownership and reader grants;
 * a successful HTTP response alone never authorizes mesh publication. */
export async function admitBrowserStatement(input: {
  item: StatementAdmissionRequest; pair: SeaPair; squad: LiveSquadSpec; config: ForumAuthorityConfig;
  endpoint: string; read: ForumAuthorityReader; fetch: typeof fetch; signal: AbortSignal; clock?: () => number;
}) {
  const item = { ...input.item }, pair = { ...input.pair }, squad = { ...input.squad }, config = structuredClone(input.config);
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000)), at = clock();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(1500)]);
  const current = () => { signal.throwIfAborted(); if (clock() !== at) throw Error("Statement authority expired"); };
  current();
  if (!/^\/[A-Za-z0-9/_-]+$/.test(input.endpoint) || input.endpoint.startsWith("//") ||
      !isForumObjectId(item.id, "stmt") || !sameEmbeddedPrincipal(item.author, item.id) ||
      !Number.isSafeInteger(item.ts) || item.ts < 0 || item.ts > at || at - item.ts > 300) throw Error("Invalid statement admission");
  const snapshot = await input.read(at, signal);
  if (!snapshot) throw Error("Statement authority unavailable");
  const authority = createForumAuthority(config, clock), result = await authority.refresh(snapshot, at);
  current();
  const permitted = () => authority.graph.ownerOf(squad.forumId) === squad.owner &&
    authority.graph.principalForKey(pair.pub, at) === item.author && authority.graph.writerKey(item.author, item.ts, at) === pair.pub &&
    authority.graph.checkForumSee(squad.forumId, item.author, at).allowed && authority.graph.checkPost(squad.forumId, item.author, at).allowed;
  if (!result.ok || result.diagnostics.length || !permitted()) throw Error("Statement authority denied");
  // Bound the intended audience to the current complete forum roster. Do not
  // grant to unknown principals, or truncate a larger audience silently.
  const readers = [...new Set(snapshot.history.accounts.map(account => account.principal))]
    .filter(principal => principal !== item.author && authority.graph.checkForumSee(squad.forumId, principal, at).allowed);
  if (readers.length > 64) throw Error("Statement audience too large");
  const [x, y] = pair.pub.split(".");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: pair.priv, ext: false, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sign = async (kind: AuthorityKind, fields: Record<string, unknown>) => {
    current();
    const parsed = parseForumAuthority(kind, { ...fields, sig: "pending" });
    if (!parsed) throw Error("Invalid statement grant");
    const bytes = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(parsed.bytes)));
    const sig = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { kind, soul: parsed.soul, record: { ...fields, sig } };
  };
  // Stable rows on retry, including after an uncertain HTTP response. Reader
  // access lasts at most one hour and is never extended by retrying a draft.
  const rows = [await sign("object", { object: item.id, owner: item.author, issuedAt: item.ts })];
  for (const accessor of readers) rows.push(await sign("see", { object: item.id, owner: item.author, accessor,
    from: item.ts, until: item.ts + 3600, stated: 1, hamState: item.ts, issuedAt: item.ts }));
  current();
  const fetcher = input.fetch;
  const response = await fetcher(input.endpoint, { method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ version: 1, forumId: squad.forumId, owner: squad.owner, evaluatedAt: at, rows }) });
  // No response body is needed: read the authoritative history independently.
  await response.body?.cancel();
  current();
  if (response.status !== 200 || response.redirected) throw Error("Statement admission unavailable");
  const admitted = await input.read(at, signal);
  if (!admitted) throw Error("Statement admission not confirmed");
  const checked = await authority.refresh(admitted, at);
  current();
  if (!checked.ok || checked.diagnostics.length || !permitted() || !authority.graph.checkDirectSee(item.id, item.author, at).allowed ||
      !authority.graph.checkPost(item.id, item.author, at).allowed) throw Error("Statement admission not confirmed");
  return { snapshot: admitted, at };
}
