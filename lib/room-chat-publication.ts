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
