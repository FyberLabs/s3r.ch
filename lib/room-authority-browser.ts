import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";
import type { SeaPair } from "./identity/sea";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { isForumObjectId, sameEmbeddedPrincipal } from "./identity/forum-check";
import type { ForumAuthorityReader } from "./forum-authority-source";
import type { LiveSquadSpec } from "./squad-view";

type RoomAdmissionRequest = Readonly<{ id: string; author: string; ts: number }>;

/** Sign room ownership and, on explicit sharing, the current parent audience.
 * The protected endpoint independently admits its ownership and reader grants;
 * a successful HTTP response alone never authorizes mesh publication. */
export async function admitBrowserRoom(input: {
  item: RoomAdmissionRequest; share: boolean; pair: SeaPair; squad: LiveSquadSpec; config: ForumAuthorityConfig;
  endpoint: string; read: ForumAuthorityReader; fetch: typeof fetch; signal: AbortSignal; clock?: () => number;
}) {
  const item = { ...input.item }, pair = { ...input.pair }, squad = { ...input.squad }, config = structuredClone(input.config);
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000)), at = clock();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(1500)]);
  const current = () => { signal.throwIfAborted(); if (clock() !== at) throw Error("Room authority expired"); };
  current();
  if (!/^\/[A-Za-z0-9/_-]+$/.test(input.endpoint) || input.endpoint.startsWith("//") ||
      !isForumObjectId(item.id, "room") || !sameEmbeddedPrincipal(item.author, item.id) ||
      !Number.isSafeInteger(item.ts) || item.ts < 0 || item.ts > at) throw Error("Invalid room admission");
  const snapshot = await input.read(at, signal);
  if (!snapshot) throw Error("Room authority unavailable");
  const authority = createForumAuthority(config, clock), result = await authority.refresh(snapshot, at);
  current();
  const permitted = () => authority.graph.ownerOf(squad.forumId) === squad.owner &&
    authority.graph.principalForKey(pair.pub, at) === item.author && authority.graph.writerKey(item.author, at, at) === pair.pub &&
    authority.graph.checkForumSee(squad.forumId, item.author, at).allowed && authority.graph.checkPost(squad.forumId, item.author, at).allowed;
  if (!result.ok || !permitted()) throw Error("Room authority denied");
  // Bound the intended audience to the current complete forum roster. Do not
  // grant to unknown principals, or truncate a larger audience silently.
  const readers = (input.share ? [...new Set(snapshot.history.accounts.map(account => account.principal))] : [])
    .filter(principal => principal !== item.author && authority.graph.checkForumSee(squad.forumId, principal, at).allowed);
  if (readers.length > 64) throw Error("Room audience too large");
  const [x, y] = pair.pub.split(".");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: pair.priv, ext: false, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sign = async (kind: AuthorityKind, fields: Record<string, unknown>) => {
    current();
    const parsed = parseForumAuthority(kind, { ...fields, sig: "pending" });
    if (!parsed) throw Error("Invalid room grant");
    const bytes = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(parsed.bytes)));
    const sig = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { kind, soul: parsed.soul, record: { ...fields, sig } };
  };
  // Ownership remains stable. Each explicit share signs a new bounded grant;
  // neither this client nor the transport retries mutations automatically.
  const rows = [await sign("object", { object: item.id, owner: item.author, issuedAt: at })];
  for (const accessor of readers) {
    rows.push(await sign("see", { object: item.id, owner: item.author, accessor,
      from: at, until: at + 3600, stated: 1, hamState: at, issuedAt: at }));
    if (authority.graph.checkPost(squad.forumId, accessor, at).allowed)
      rows.push(await sign("post", { object: item.id, owner: item.author, accessor,
        from: at, until: at + 3600, stated: 1, hamState: at, issuedAt: at }));
  }
  if (rows.length > 65) throw Error("Room audience too large");
  // Verify the newly signed ownership together with retained rows before posting.
  // This lets a current key refresh its old room without trusting the old row.
  const candidate = { ...snapshot, rows: [...snapshot.rows, ...rows] };
  const proposed = await authority.refresh(candidate, at);
  if (!proposed.ok || roomAuthorityDiagnosticsBlock(proposed.diagnostics, candidate, authority.graph, item.id) || !permitted())
    throw Error("Room authority denied");
  current();
  const fetcher = input.fetch;
  const response = await fetcher(input.endpoint, { method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ version: 1, forumId: squad.forumId, owner: squad.owner, evaluatedAt: at, rows }) });
  // No response body is needed: read the authoritative history independently.
  await response.body?.cancel();
  current();
  if (response.status !== 200 || response.redirected) throw Error("Room admission unavailable");
  const admitted = await input.read(at, signal);
  if (!admitted) throw Error("Room admission not confirmed");
  const checked = await authority.refresh(admitted, at);
  current();
  if (!checked.ok || roomAuthorityDiagnosticsBlock(checked.diagnostics, admitted, authority.graph, item.id) || !permitted() || !authority.graph.checkDirectSee(item.id, item.author, at).allowed ||
      !authority.graph.checkPost(item.id, item.author, at).allowed) throw Error("Room admission not confirmed");
  for (const accessor of readers) {
    if (!authority.graph.checkForumSee(item.id, accessor, at).allowed ||
        (authority.graph.checkPost(squad.forumId, accessor, at).allowed && !authority.graph.checkPost(item.id, accessor, at).allowed))
      throw Error("Room sharing not confirmed");
  }
  return { snapshot: admitted, at };
}
