import type { InventoryStore } from "./delegation-inventory";
import { createAssignmentJournal, type AssignmentJournalState } from "./delegation-journal";
import { createForumAuthoritySnapshotStore } from "./forum-authority-store";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import { squadView, type LiveSquadSpec } from "./squad-view";

type History = ForumAuthoritySnapshot["history"];
type Document = { version: 1; journal: AssignmentJournalState; history: History };
const CAP = 6 * 1024 * 1024;
const fixed = (text: string): InventoryStore => ({ read: async () => ({ text, etag: "validation" }), compareAndSwap: async () => false });
/** A single primary CAS slot owns history AND the assignment journal. All
 * mutation paths must use this slot. Separate legacy blobs cannot provide this
 * guarantee. Provision/import only through authenticated operator code. */
export function createSquadCommitStore(store: InventoryStore, spec: LiveSquadSpec, clock = () => Math.floor(Date.now() / 1000)) {
  const view = squadView(spec);
  if (!view.live) throw Error("Live Squad required");
  const snapshot = (doc: Document): ForumAuthoritySnapshot => ({ completeThrough: doc.history.completeThrough, history: doc.history, rows: doc.journal.rows });
  const sourceText = (doc: Document) => JSON.stringify({ version: 1, forumId: view.forumId, owner: view.owner, snapshot: snapshot(doc) });
  async function validate(text: string): Promise<Document> {
    if (new TextEncoder().encode(text).byteLength > CAP) throw Error("combined authority capacity");
    const doc = JSON.parse(text) as Document;
    if (!doc || Object.keys(doc).sort().join() !== "history,journal,version" || doc.version !== 1) throw Error("invalid combined authority");
    const journal = await createAssignmentJournal(fixed(JSON.stringify(doc.journal)), clock).load();
    if (journal.forum !== view.forumId || journal.owner !== view.owner) throw Error("combined scope mismatch");
    await createForumAuthoritySnapshotStore(fixed(sourceText(doc)), spec).load();
    return doc;
  }
  async function load() {
    const held = await store.read();
    if (!held || !held.etag || held.etag === "*") throw Error("missing combined authority");
    return { ...held, doc: await validate(held.text) };
  }
  return Object.freeze({
    async initialize(journal: AssignmentJournalState, history: History) {
      const text = JSON.stringify({ version: 1, journal, history }); await validate(text);
      if (!await store.compareAndSwap(null, text)) throw Error("combined authority already provisioned");
    },
    async read(at: number, signal: AbortSignal) {
      signal.throwIfAborted(); const held = await load(); signal.throwIfAborted();
      return createForumAuthoritySnapshotStore(fixed(sourceText(held.doc)), spec).read(at, signal);
    },
    async load() { const held = await load(); return { etag: held.etag, journal: held.doc.journal, history: held.doc.history }; },
    async updateHistory(expectedETag: string, history: History) {
      const nextHistory = structuredClone(history), held = await load();
      if (held.etag !== expectedETag) return false;
      const candidate = { ...held.doc, history: nextHistory, journal: { ...held.doc.journal, revision: held.doc.journal.revision + 1 } };
      // Reuse the existing evidence retention/horizon rules before the CAS.
      const retention = createForumAuthoritySnapshotStore({ read: async () => ({ text: sourceText(held.doc), etag: held.etag }), compareAndSwap: async () => true }, spec);
      await retention.replace(held.etag, snapshot(candidate));
      const text = JSON.stringify(candidate); await validate(text);
      return store.compareAndSwap(expectedETag, text);
    },
    async open() {
      let held = await load(), poisoned = false;
      // This view belongs to one runtime request. It must never refresh its
      // history independently after verification or silently retry a lost CAS.
      const journalStore: InventoryStore = {
        read: async () => {
          if (poisoned) throw Error("combined view invalid; reopen");
          return { text: JSON.stringify(held.doc.journal), etag: held.etag };
        },
        compareAndSwap: async (etag, journalText) => {
          if (poisoned || etag !== held.etag) return false;
          const text = JSON.stringify({ ...held.doc, journal: JSON.parse(journalText) }); await validate(text);
          try {
            if (!await store.compareAndSwap(etag, text)) { poisoned = true; return false; }
            const next = await load();
            if (next.text !== text) throw Error("combined authority advanced; reopen");
            held = next; return true;
          } catch (error) { poisoned = true; throw error; }
        },
      };
      return Object.freeze({ journal: createAssignmentJournal(journalStore, clock),
        async history(at: number) {
          if (poisoned || !Number.isSafeInteger(at) || at < 0 || held.doc.history.completeThrough < at) throw Error("combined history unavailable");
          return structuredClone(held.doc.history);
        },
      });
    },
  });
}
