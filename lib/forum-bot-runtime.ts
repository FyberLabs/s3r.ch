import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthorityGraph } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { isSeaPubkey } from "./identity/forum-check";
import type { SeaPair } from "./identity/sea";
import type { BotInboxScope } from "./forum-bot-inbox";
import { createHttpForumAuthorityReader } from "./forum-authority-http";
import { openLocalBotApprovals, privateBotDirectory, readPrivateBotFile } from "./forum-bot-local-access";
import { openForumBotArtifacts } from "./forum-bot-artifacts";
import { openForumBotChannel } from "./forum-bot-channel";
import { openForumBotOutbox } from "./forum-bot-outbox";
import { createForumBotWorker } from "./forum-bot-worker";
import { createLocalBotExecutor } from "./forum-bot-executor";
import { createForumBotGunTransport } from "./forum-bot-gun";
import { createBotSession } from "./forum-bot-session";
import { buildForumStatement, forumStatementFromNode } from "./forum-squad";
import { signForumRecord, readForumSignature } from "./forum-sign";
import { toGunNode } from "./feed-types";

export function currentBotReportReaders(authority: ForumAuthorityGraph, forum: string, principal: string, principals: readonly string[], at: number) {
  return principals.filter(p => p !== principal && authority.checkForumSee(forum, p, at).allowed);
}

type Config = { version: 1; scope: BotInboxScope; owner: string; bots: Record<string, string>; rootSenders: string[];
  maxDelegationDepth: number; authority: ForumAuthorityConfig; origin: string; authorityEndpoint: string;
  statementEndpoint: string; peer: string; approvalsDirectory: string; stateDirectory: string;
  pairFile: string; visorOrigin: string; visorTokenFile: string };
async function responseOK(response: Response) {
  if (response.status !== 200 || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
    await response.body?.cancel(); return false;
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 1024) { await reader.cancel(); return false; } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))?.ok === true;
}
/** Executable wiring uses only explicitly provisioned endpoints and identities.
 * The statement endpoint must implement createBotStatementAdmission with a
 * genuine atomic source. The legacy Squad journal is not silently substituted.
 */
export async function openForumBotRuntime(configPath: string, artifactOnly = false) {
  const c = JSON.parse(readPrivateBotFile(configPath).toString("utf8")) as Config;
  if (!c || Object.keys(c).sort().join() !== "approvalsDirectory,authority,authorityEndpoint,bots,maxDelegationDepth,origin,owner,pairFile,peer,rootSenders,scope,stateDirectory,statementEndpoint,version,visorOrigin,visorTokenFile" || c.version !== 1)
    throw Error("Invalid forum worker configuration");
  privateBotDirectory(c.stateDirectory); privateBotDirectory(c.approvalsDirectory);
  const peer = new URL(c.peer);
  if (peer.protocol !== "https:" || peer.username || peer.password || peer.search || peer.hash) throw Error("Explicit HTTPS Gun peer required");
  if (!/^\/[A-Za-z0-9/_-]+$/.test(c.statementEndpoint) || c.statementEndpoint.startsWith("//")) throw Error("Explicit statement endpoint required");
  const pair = JSON.parse(readPrivateBotFile(c.pairFile, 8192).toString("utf8")) as SeaPair;
  if (!isSeaPubkey(pair.pub) || typeof pair.priv !== "string") throw Error("Independent SEA bot key required");
  const principals = [...new Set([...c.rootSenders, ...Object.values(c.bots)])];
  if (principals.length > 64) throw Error("Bot reader capacity reached");
  const session = createBotSession({ origin: c.origin, pair });
  if (!await session.signIn()) throw Error("Independent bot sign-in unavailable");
  const authority = createForumAuthority(c.authority), spec = { forumId: c.scope.forum, owner: c.owner, label: "Bot thread" };
  const reader = createHttpForumAuthorityReader({ endpoint: c.authorityEndpoint, squad: spec, fetch: session.fetch });
  let last = -1, lastSignInAttempt = 0;
  async function refresh(force = false): Promise<boolean> {
    let at = Math.floor(Date.now() / 1000);
    if (!force && last === at && authority.graph.ownerOf(c.scope.forum) === c.owner) return true;
    authority.invalidate();
    try {
      let snapshot = await reader(at, AbortSignal.timeout(900));
      if (!snapshot && Date.now() - lastSignInAttempt > 30000) {
        lastSignInAttempt = Date.now();
        if (await session.signIn()) { at = Math.floor(Date.now() / 1000); snapshot = await reader(at, AbortSignal.timeout(900)); }
      }
      if (!snapshot) return false;
      const result = await authority.refresh(snapshot, at); last = at;
      return result.ok && result.diagnostics.length === 0 && authority.graph.ownerOf(c.scope.forum) === c.owner &&
        authority.graph.writerKey(c.scope.principal, at, at) === pair.pub;
    } catch { authority.invalidate(); return false; }
  }
  const approvals = openLocalBotApprovals(c.approvalsDirectory, c.scope), directory = join(c.stateDirectory, "artifacts");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const artifacts = openForumBotArtifacts({ directory, scope: c.scope, authority: authority.graph, approval: approvals.read });
  if (artifactOnly) return Object.freeze({
    async readArtifact(request: Parameters<typeof artifacts.read>[0]) { if (!await refresh(true)) throw Error("Artifact authority unavailable"); return artifacts.read(request); },
    close: () => session.close(),
  });
  if (!await refresh(true) || !await responseOK(await session.fetch(c.statementEndpoint, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, forumId: c.scope.forum,
      owner: c.owner, evaluatedAt: Math.floor(Date.now() / 1000), rows: [] }) }))) {
    await session.close(); throw Error("Independent statement provider unavailable");
  }
  const localExecutor = createLocalBotExecutor({ origin: c.visorOrigin, tokenFile: c.visorTokenFile });
  let localConsent = { session: "", running: false, at: 0 };
  const executor = { ...localExecutor, async consent(id: string) {
    localConsent = { session: id, running: false, at: Date.now() };
    const result = await localExecutor.consent(id);
    localConsent = { session: id, running: result.running, at: Date.now() }; return result;
  } };
  const channel = openForumBotChannel({ path: join(c.stateDirectory, "inbox.sqlite"), scope: c.scope, owner: c.owner,
    bots: c.bots, rootSenders: c.rootSenders, maxDelegationDepth: c.maxDelegationDepth, authority: authority.graph,
    handleAllowed: handle => approvals.read(handle) !== null,
    localConsent: (_scope, handle) => localConsent.running && Date.now() - localConsent.at <= 1000 &&
      approvals.read(handle)?.session === localConsent.session });
  const outbox = openForumBotOutbox(join(c.stateDirectory, "outbox.sqlite"), c.scope);
  const worker = createForumBotWorker({ tenant: c.scope.tenant, channel, approvals, artifacts, executor,
    refresh, publish: async message => outbox.enqueue(message) });
  const Gun = createRequire(import.meta.url)("gun");
  const gun = Gun({ peers: [c.peer], radisk: false, localStorage: false, axe: false });
  const transport = createForumBotGunTransport({ gun, tenant: c.scope.tenant, forum: c.scope.forum, principal: c.scope.principal,
    authority: authority.graph, principals, worker });
  const signRow = (kind: AuthorityKind, record: Record<string, unknown>) => {
    const row = { ...record, sig: "pending" }, parsed = parseForumAuthority(kind, row);
    if (!parsed) throw Error("Invalid statement grant");
    row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(pair.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record: row };
  };
  async function flush() {
    const report = outbox.next(); if (!report || !await refresh()) return;
    let node = report.node;
    if (!node) {
      const item = buildForumStatement({ forumId: c.scope.forum, author: c.scope.principal, body: report.body,
        now: Math.floor(Date.now() / 1000), entropy: report.id.slice(-32) });
      if (!item || item.id !== report.id) throw Error("Invalid outgoing bot statement");
      const data = toGunNode(item), sig = await signForumRecord(data, pair); if (!sig) throw Error("Bot signing failed");
      node = { ...data, sig }; outbox.stage(report.id, node);
    }
    const at = Math.floor(Date.now() / 1000), item = forumStatementFromNode(await readForumSignature(String(node.sig), pair.pub), c.scope.forum);
    if (!item || item.id !== report.id || item.author !== c.scope.principal || item.body !== report.body ||
        authority.graph.writerKey(c.scope.principal, item.ts, at) !== pair.pub) throw Error("Outgoing bot authority unavailable");
    const grantAt = Math.max(item.ts, Math.floor(at / 3600) * 3600);
    const rows = [signRow("object", { object: item.id, owner: c.scope.principal, issuedAt: item.ts }),
      ...currentBotReportReaders(authority.graph, c.scope.forum, c.scope.principal, principals, at).map(accessor => signRow("see", { object: item.id, owner: c.scope.principal,
        accessor, from: grantAt, until: grantAt + 3600, stated: 1, hamState: grantAt, issuedAt: grantAt }))];
    if (!await responseOK(await session.fetch(c.statementEndpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, forumId: c.scope.forum, owner: c.owner, evaluatedAt: at, rows }) })))
      throw Error("Signed statement admission unavailable");
    if (!await refresh(true) || !authority.graph.checkPost(item.id, c.scope.principal, Math.floor(Date.now() / 1000)).allowed ||
        !authority.graph.checkPost(c.scope.forum, c.scope.principal, Math.floor(Date.now() / 1000)).allowed)
      throw Error("Outgoing statement permission unavailable");
    await transport.put(node); outbox.sent(report.id);
  }
  let busy = false, closed = false, idle: Promise<void> = Promise.resolve();
  return Object.freeze({
    async tick() {
      if (busy || closed) return; busy = true;
      let release!: () => void; idle = new Promise<void>(resolve => { release = resolve; });
      try {
        try { if (await refresh()) await transport.tick(); } finally { await worker.tick(); }
        if (!closed) await flush();
      } finally { busy = false; release(); }
    },
    async readArtifact(request: Parameters<typeof artifacts.read>[0]) { if (!await refresh(true)) throw Error("Artifact authority unavailable"); return artifacts.read(request); },
    async close() {
      if (closed) return; closed = true; await idle; transport.close();
      try { await worker.stop(); } finally { channel.close(); outbox.close(); await session.close(); }
    },
  });
}
