import type { ForumAuthorityGraph } from "./identity/forum-authority";
import type { ChatMessage } from "./chat";
import type { RoomChatAdmission } from "./room-chat-admission";
import { isRoomTaskBody } from "./room-tasks";

/** Call after admission awaits, reading current local rows and publication state.
 * Captured compose-time visibility must not decide an eventual public write. */
export function publishCurrentRoomChat(input: {
  room: string; currentRows(): readonly ChatMessage[]; publicRoom(): boolean;
  admission: Pick<RoomChatAdmission, "valid">; publish(row: ChatMessage): void;
}): void {
  if (!input.publicRoom()) return;
  for (const row of input.currentRows()) {
    if (row.room !== input.room || isRoomTaskBody(row.body)) continue;
    if (!input.publicRoom()) return;
    if (input.admission.valid(row)) input.publish(row);
  }
}


/** Mesh presence is not the owner's consent to publish Mine-only messages.
 * Owner consent is held only after this mount's explicit signed share succeeds;
 * a new session/device must confirm again rather than infer consent from peers. */
export function roomChatPublicationAllowed(input: {
  room: string; readerKey: string | null; now: number;
  graph: Pick<ForumAuthorityGraph, "ownerOf" | "principalForKey">;
  publishedRooms: ReadonlySet<string>; ownerConfirmedShares: ReadonlySet<string>;
}): boolean {
  const principal = input.readerKey && input.graph.principalForKey(input.readerKey, input.now);
  const owner = input.graph.ownerOf(input.room);
  return !!principal && !!owner && input.publishedRooms.has(input.room) &&
    (owner !== principal || input.ownerConfirmedShares.has(input.room));
}
