import type { InventoryStore } from "./delegation-inventory";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import { isSeaPubkey } from "./identity/forum-check";
import { squadView, type LiveSquadSpec } from "./squad-view";

const CAP = 4 * 1024 * 1024;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
const exact = (x: unknown, keys: string): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join() === keys;
const list = (x: unknown, max = 1024): x is unknown[] => Array.isArray(x) && x.length <= max;
/** Dedicated primary CAS document. Writer authorization and source completeness
 * belong to the trusted importer. This storage layer preserves evidence; it does
 * not authenticate signatures or confer ACL authority. Never mirror arbitrary
 * peer data here or join independently read history and ACL snapshots.
 */
export function createForumAuthoritySnapshotStore(store: InventoryStore, squad: LiveSquadSpec) {
  const view = squadView(squad);
  if (!view.live) throw Error("Live Squad required");
  function parse(text: string): ForumAuthoritySnapshot {
    if (new TextEncoder().encode(text).byteLength > CAP) throw Error("authority snapshot capacity");
    const doc = JSON.parse(text);
    if (!exact(doc, "forumId,owner,snapshot,version") || doc.version !== 1 || doc.forumId !== view.forumId || doc.owner !== view.owner) throw Error("authority scope mismatch");
    const s = doc.snapshot;
    if (!exact(s, "completeThrough,history,rows") || !integer(s.completeThrough) || !list(s.rows) ||
        !exact(s.history, "accounts,completeThrough,links") || !integer(s.history.completeThrough) || !list(s.history.links) || !list(s.history.accounts, 128)) throw Error("invalid authority snapshot");
    const principals = new Set();
    for (const account of s.history.accounts) {
      if (!exact(account, "genesisEpubBindings,principal,revocations,rotations") || typeof account.principal !== "string" ||
          !isSeaPubkey(account.principal) || principals.has(account.principal) || !list(account.rotations) || !list(account.revocations) || !list(account.genesisEpubBindings)) throw Error("invalid history account");
      principals.add(account.principal);
    }
    return s as unknown as ForumAuthoritySnapshot;
  }
  function encode(snapshot: ForumAuthoritySnapshot) {
    const text = JSON.stringify({ version: 1, forumId: view.forumId, owner: view.owner, snapshot });
    return { text, snapshot: parse(text) };
  }
  async function load() {
    const held = await store.read();
    if (!held || !held.etag || held.etag === "*") throw Error("missing authority snapshot");
    return { etag: held.etag, snapshot: parse(held.text) };
  }
  function retains(previous: readonly unknown[], next: readonly unknown[]) {
    // Conservative exact JSON record retention; never infer that a higher HAM
    // row makes historical cancellation or recovery evidence dispensable.
    const records = new Set(next.map(row => JSON.stringify(row)));
    if (previous.some(row => !records.has(JSON.stringify(row)))) throw Error("authority evidence removed");
  }
  return Object.freeze({
    load,
    async initialize(snapshot: ForumAuthoritySnapshot) {
      const next = encode(snapshot);
      if (!await store.compareAndSwap(null, next.text)) throw Error("authority snapshot already provisioned");
    },
    async replace(expectedETag: string, snapshot: ForumAuthoritySnapshot) {
      const next = encode(snapshot), previous = await load();
      if (previous.etag !== expectedETag) return false;
      const before = previous.snapshot, after = next.snapshot;
      if (after.completeThrough < before.completeThrough || after.history.completeThrough < before.history.completeThrough) throw Error("authority horizon regressed");
      retains(before.rows, after.rows); retains(before.history.links, after.history.links);
      for (const old of before.history.accounts) {
        const account = after.history.accounts.find(a => a.principal === old.principal);
        if (!account) throw Error("history account removed");
        retains(old.rotations, account.rotations); retains(old.revocations, account.revocations); retains(old.genesisEpubBindings, account.genesisEpubBindings);
      }
      return store.compareAndSwap(expectedETag, next.text);
    },
    async read(at: number, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!integer(at)) throw Error("invalid evaluation time");
      const { snapshot } = await load();
      signal.throwIfAborted();
      if (snapshot.completeThrough < at || snapshot.history.completeThrough < at) throw Error("incomplete authority snapshot");
      return snapshot;
    },
  });
}
