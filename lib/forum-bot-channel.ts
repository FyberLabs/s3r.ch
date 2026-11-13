/** Signed forum admission for the private bot inbox. No legacy owner token is
 * accepted here; each bot is provisioned with its own independently granted key.
 */
import { createHash } from "node:crypto";
import { isSeaPubkey, isForumObjectId, sameEmbeddedPrincipal } from "./identity/forum-check";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { forumStatementFromNode } from "./forum-squad";
import { readForumSignature } from "./forum-sign";
import { parseBotMessage, type BotTaskMessage } from "./forum-bot-protocol";
import { openForumBotInbox, type BotInboxScope, type BotInboxTask, type BotInboxCursor } from "./forum-bot-inbox";

export type SignedBotStatement = Readonly<{ id: string; author: string; issuedAt: number; signature: string }>;
type Link = Readonly<{ message: string; author: string; at: number; key: string; recipient: string; task: BotTaskMessage }>;
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function openForumBotChannel(input: {
  path: string; scope: BotInboxScope; owner: string;
  bots: Readonly<Record<string, string>>;
  rootSenders: readonly string[];
  maxDelegationDepth?: number;
  authority: ForumAuthorityGraph;
  handleAllowed(handle: string, scope: BotInboxScope, operation: "receive" | "dispatch"): boolean;
  localConsent(scope: BotInboxScope, handle: string): boolean;
  clock?: () => number;
}) {
  const scope = Object.freeze({ ...input.scope }), bots = Object.freeze({ ...input.bots });
  const roots = new Set(input.rootSenders), owner = input.owner, depth = input.maxDelegationDepth ?? 0;
  const { authority, handleAllowed, localConsent } = input;
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const principals = Object.values(bots);
  if (!isForumObjectId(scope.forum, "forum") || !isSeaPubkey(owner) || !sameEmbeddedPrincipal(owner, scope.forum) ||
      bots[scope.bot] !== scope.principal || !Number.isInteger(depth) || depth < 0 || depth > 4 ||
      principals.length < 1 || principals.length > 128 || new Set(principals).size !== principals.length ||
      Object.entries(bots).some(([id, key]) => !uuid(id) || !isSeaPubkey(key)) ||
      roots.size < 1 || roots.size > 128 || [...roots].some(key => !isSeaPubkey(key) || principals.includes(key)))
    throw Error("Invalid forum bot provisioning");
  const proofs = new Map<string, readonly Link[]>();
  let stopped = false, receiving = false;
  let cancelling: { id: string; ancestor: string } | null = null;
  function valid(chain: readonly Link[], report = false): boolean {
    const at = clock();
    if (stopped || !Number.isSafeInteger(at) || at < 0 || authority.ownerOf(scope.forum) !== owner ||
        chain.length < 1 || chain.length > depth + 1) return false;
    const first = chain[0], visited = new Set<string>([first.author]), ids = new Set<string>();
    if (!roots.has(first.author) || first.task[6] !== null || chain.length > first.task[7] + 1) return false;
    for (let i = 0; i < chain.length; i++) {
      const link = chain[i], task = link.task, previous = chain[i - 1];
      if (task[1] !== scope.tenant || bots[task[3]] !== link.recipient || visited.has(link.recipient) || ids.has(task[2]) ||
          link.at > at || (!report && (task[5] <= at || inbox.blocked(task[2]))) || task[5] > link.at + 3600 ||
          authority.writerKey(link.author, link.at, at) !== link.key ||
          !authority.writerKey(link.recipient, at, at) ||
          authority.checkForumSee(scope.forum, link.author, at).allowed !== true ||
          authority.checkPost(scope.forum, link.author, at).allowed !== true ||
          authority.checkForumSee(scope.forum, link.recipient, at).allowed !== true ||
          authority.checkPost(scope.forum, link.recipient, at).allowed !== true ||
          authority.checkDirectSee(link.message, link.author, at).allowed !== true ||
          authority.checkPost(link.message, link.author, at).allowed !== true ||
          authority.checkForumSee(link.message, scope.principal, at).allowed !== true ||
          (i > 0 && (task[6] !== previous.task[2] || link.author !== previous.recipient ||
            link.at < previous.at || task[5] > previous.task[5] || task[7] !== first.task[7]))) return false;
      visited.add(link.recipient); ids.add(task[2]);
    }
    return true;
  }
  const context = (chain: readonly Link[]) => createHash("sha256").update(JSON.stringify(chain.map(link =>
    [link.message, link.author, link.at, link.recipient, link.task]))).digest("hex");
  const inbox = openForumBotInbox({ path: input.path, scope, clock,
    authorize(task, operation) {
      const chain = proofs.get(task.id), last = chain?.at(-1);
      const checked = operation === "cancel" && chain && cancelling ?
        chain.slice(0, chain.findIndex(link => link.task[2] === cancelling!.ancestor) + 1) : chain;
      return !!chain && !!last && !!checked && valid(checked, operation === "cancel") && last.task[3] === scope.bot && task.context === context(chain) &&
        (operation === "cancel" ? cancelling?.id === task.id : handleAllowed(task.handle, scope, operation) === true) &&
        (operation !== "dispatch" || localConsent(scope, task.handle) === true);
    },
  });
  return Object.freeze({
    close() { stopped = true; proofs.clear(); inbox.close(); },
    cursor: inbox.cursor,
    status: inbox.status,
    reference(id: string) { const chain = proofs.get(id), last = chain?.at(-1);
      return chain && last && valid(chain) ? Object.freeze({ handle: last.task[4], expires: last.task[5] }) : null; },
    pending: () => [...proofs.keys()].filter(id => inbox.status(id) === "pending"),
    authorized(id: string) {
      const chain = proofs.get(id), last = chain?.at(-1);
      return !!chain && !!last && valid(chain) && last.task[3] === scope.bot &&
        handleAllowed(last.task[4], scope, "dispatch") === true && localConsent(scope, last.task[4]) === true;
    },
    claim: inbox.claim,
    finish: inbox.finish,
    /** Admit status only for a previously verified task. The caller must replay
     * its signed task chain after restart before accepting any correlated event.
     * Remote status is informational: it never finishes a local worker claim.
     */
    async event(statement: SignedBotStatement) {
      if (stopped || receiving) throw Error("Invalid or busy forum bot delivery");
      const row = Object.freeze({ ...statement });
      if (Object.keys(row).sort().join() !== "author,id,issuedAt,signature" ||
          !isSeaPubkey(row.author) || !isForumObjectId(row.id, "stmt") || !sameEmbeddedPrincipal(row.author, row.id) ||
          !Number.isSafeInteger(row.issuedAt) || row.issuedAt < 0 || typeof row.signature !== "string" || row.signature.length > 32768)
        throw Error("Invalid signed bot event");
      receiving = true;
      try {
        const key = authority.writerKey(row.author, row.issuedAt, clock());
        if (!key) throw Error("Forum bot signer unavailable");
        const item = forumStatementFromNode(await readForumSignature(row.signature, key), scope.forum);
        const message = parseBotMessage(item?.body);
        if (!item || item.id !== row.id || item.author !== row.author || item.ts !== row.issuedAt ||
            item.kind !== "statement" || !message || message[0] === "task" || message[1] !== scope.tenant)
          throw Error("Invalid signed bot event");
        const retained = proofs.get(message[2]) ?? (message[0] === "cancel" ? [...proofs.values()].find(links =>
          links.some(link => link.task[2] === message[2])) : undefined);
        const chain = message[0] === "cancel" ? retained?.slice(0, retained.findIndex(link => link.task[2] === message[2]) + 1) : retained;
        const last = chain?.at(-1), at = clock();
        if (!chain || !last || !valid(chain, true) || row.issuedAt < last.at || row.issuedAt > at ||
            authority.writerKey(row.author, row.issuedAt, at) !== key ||
            authority.checkForumSee(scope.forum, row.author, at).allowed !== true ||
            authority.checkPost(scope.forum, row.author, at).allowed !== true ||
            authority.checkDirectSee(item.id, row.author, at).allowed !== true ||
            authority.checkPost(item.id, row.author, at).allowed !== true ||
            authority.checkForumSee(item.id, scope.principal, at).allowed !== true ||
            (message[0] === "cancel" ? row.author !== chain[0].author && row.author !== last.author : row.author !== last.recipient))
          throw Error("Forum bot event authority unavailable");
        let cancelled = false;
        const affected: string[] = [];
        if (message[0] === "cancel") {
          inbox.block(message[2]); // Persist ancestor revocation before touching descendants.
          for (const [id, links] of proofs) if (links.some(link => link.task[2] === message[2])) {
            affected.push(id); cancelling = { id, ancestor: message[2] };
            try { cancelled = inbox.cancel(id) || cancelled; } finally { cancelling = null; }
          }
        }
        // A false cancellation result explicitly leaves active/unknown work alone.
        // Artifact handles still require their own access check before retrieval.
        return Object.freeze({ id: item.id, author: item.author, issuedAt: item.ts, message, cancelled, affected: Object.freeze(affected) });
      } finally { receiving = false; }
    },
    async receive(chainInput: readonly SignedBotStatement[], cursor?: BotInboxCursor) {
      if (stopped || receiving || !Array.isArray(chainInput) || chainInput.length < 1 || chainInput.length > depth + 1)
        throw Error("Invalid or busy forum bot delivery");
      // Pin all transport fields before asynchronous cryptographic verification.
      const statements = chainInput.map(row => Object.freeze({ ...row }));
      if (statements.some(row => Object.keys(row).sort().join() !== "author,id,issuedAt,signature" ||
          !isSeaPubkey(row.author) || !isForumObjectId(row.id, "stmt") || !sameEmbeddedPrincipal(row.author, row.id) ||
          !Number.isSafeInteger(row.issuedAt) || row.issuedAt < 0 || typeof row.signature !== "string" || row.signature.length > 32768))
        throw Error("Invalid signed bot statement");
      receiving = true;
      try {
        const chain: Link[] = [];
        for (const row of statements) {
          const at = clock(), key = authority.writerKey(row.author, row.issuedAt, at);
          if (!key) throw Error("Forum bot signer unavailable");
          const decoded = await readForumSignature(row.signature, key);
          const item = forumStatementFromNode(decoded, scope.forum), task = parseBotMessage(item?.body);
          if (!item || item.id !== row.id || item.author !== row.author || item.ts !== row.issuedAt ||
              item.kind !== "statement" || task?.[0] !== "task" || !bots[task[3]]) throw Error("Invalid signed bot task");
          chain.push(Object.freeze({ message: item.id, author: item.author, at: item.ts, key, recipient: bots[task[3]], task }));
        }
        const last = chain.at(-1)!;
        if (!valid(chain) || last.task[3] !== scope.bot) throw Error("Forum bot task authority unavailable");
        const task: BotInboxTask = { id: last.task[2], message: last.message, sender: last.author,
          handle: last.task[4], expires: last.task[5], context: context(chain) };
        const previous = proofs.get(task.id);
        if (!previous && proofs.size >= 4096) throw Error("Forum bot proof capacity reached");
        proofs.set(task.id, Object.freeze(chain));
        try { return inbox.receive(task, cursor); }
        catch (error) { if (previous) proofs.set(task.id, previous); else proofs.delete(task.id); throw error; }
      } finally { receiving = false; }
    },
  });
}
