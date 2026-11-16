import type { RoomChatAdmission, SignedRoomChat } from "./room-chat-admission";

export const ROOM_REPLAY_PAGE_ROWS = 32;
export const ROOM_REPLAY_PAGE_BYTES = 512 * 1024;
/** Owner contract, not a Gun adapter. Pages are JSON, bounded before decoding. */
export type RoomReplaySource = (request: Readonly<{
  room: string; snapshot: string | null; offset: number; limit: number; signal: AbortSignal;
}>) => Promise<string>;

/** Inactive until a transport supplies immutable, gap-free snapshot paging. */
export function createRoomChatReplay(input: {
  room: string;
  source: RoomReplaySource;
  admission: Pick<RoomChatAdmission, "receive" | "valid" | "canRead">;
  /** Must change on room/controller/identity replacement, even for the same SEA key. */
  binding: () => object | null;
  /** Notify synchronously on every binding or read-authority change; return cleanup. */
  watch: (changed: () => void) => () => void;
  receive: (row: SignedRoomChat) => void;
}) {
  const binding = input.binding(), abort = new AbortController();
  let run: Promise<"complete" | "cancelled"> | undefined;
  function current() {
    if (!binding || abort.signal.aborted || input.binding() !== binding || !input.admission.canRead(input.room)) {
      abort.abort(); return false;
    }
    return true;
  }
  async function replay(): Promise<"complete" | "cancelled"> {
    const unwatch = input.watch(() => { current(); });
    try { return await pages(); } finally { unwatch(); }
  }
  async function pages(): Promise<"complete" | "cancelled"> {
    let snapshot: string | null = null, offset = 0;
    while (current()) {
      const raw = await input.source(Object.freeze({room: input.room, snapshot, offset,
        limit: ROOM_REPLAY_PAGE_ROWS, signal: abort.signal}));
      if (!current()) return "cancelled";
      if (typeof raw !== "string" || raw.length > ROOM_REPLAY_PAGE_BYTES ||
          new TextEncoder().encode(raw).length > ROOM_REPLAY_PAGE_BYTES) throw new Error("Oversized replay page");
      const page = JSON.parse(raw);
      if (!page || typeof page.snapshot !== "string" || !page.snapshot.length || page.snapshot.length > 256 ||
          (snapshot !== null && page.snapshot !== snapshot) || page.offset !== offset ||
          typeof page.done !== "boolean" || !Array.isArray(page.rows) || page.rows.length > ROOM_REPLAY_PAGE_ROWS ||
          (!page.done && page.rows.length === 0) || !Number.isSafeInteger(offset + page.rows.length)) {
        throw new Error("Invalid replay cursor or page");
      }
      snapshot = page.snapshot;
      // Validate the entire page before admitting any of it; detach through JSON decoding.
      for (const entry of page.rows) {
        if (!entry || typeof entry.key !== "string" || entry.key.length > 1024 ||
            JSON.stringify(entry).length > 16 * 1024) throw new Error("Invalid replay entry");
      }
      for (let index = 0; index < page.rows.length; index++) {
        if (!current()) return "cancelled";
        const entry = page.rows[index];
        const row = await input.admission.receive(entry.value, input.room, entry.key);
        if (!current()) return "cancelled";
        if (row && input.admission.valid(row)) input.receive(row);
        offset++;
        // Serial admission, and at most eight candidates between event-loop yields.
        if ((index + 1) % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (!current()) return "cancelled";
      if (page.done) return "complete";
      // Empty final pages and short pages must not create a tight source loop.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return "cancelled";
  }
  return {
    start: () => run ??= replay().catch(error => {
      const cancelled = abort.signal.aborted;
      abort.abort();
      if (cancelled) return "cancelled" as const;
      throw error;
    }),
    close: () => abort.abort(),
  };
}
